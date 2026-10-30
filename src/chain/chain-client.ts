import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import type { RawContractEvent } from '../indexer/decoder.js';

/** Read-only view of the chain. The API never signs or submits transactions. */
export interface ChainClient {
  getLedgerBounds(): Promise<{ latestLedger: number; oldestLedger: number }>;
  /** All contract events emitted by `contractIds` in ledgers [startLedger, endLedger] (inclusive), ordered by id. */
  getContractEvents(
    contractIds: string[],
    startLedger: number,
    endLedger: number,
  ): Promise<RawContractEvent[]>;
  /** Hex WASM hash of a deployed contract, `"stellar_asset"` for SAC tokens, or null when the contract does not exist. */
  getContractWasmHash(contractId: string): Promise<string | null>;
  /** Token balance (decimal string) of `holder` via a read-only simulation, or null if the call fails. */
  getTokenBalance(token: string, holder: string): Promise<string | null>;
}

/** Simulation-only source account; never needs to exist on-chain. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
/** Soroban RPC limits: 5 filters per request, 5 contract IDs per filter. */
const CONTRACTS_PER_REQUEST = 25;
const CONTRACTS_PER_FILTER = 5;

export interface StellarChainClientOptions {
  rpcUrl: string;
  networkPassphrase: string;
  pageLimit: number;
  timeoutMs?: number;
  retries?: number;
}

export class StellarChainClient implements ChainClient {
  readonly server: rpc.Server;

  constructor(private readonly opts: StellarChainClientOptions) {
    this.server = new rpc.Server(opts.rpcUrl, {
      allowHttp: opts.rpcUrl.startsWith('http://'),
      timeout: opts.timeoutMs ?? 15_000,
    });
  }

  async getLedgerBounds() {
    const health = await this.retry(() => this.server.getHealth());
    return { latestLedger: health.latestLedger, oldestLedger: health.oldestLedger };
  }

  async getContractEvents(contractIds: string[], startLedger: number, endLedger: number) {
    const all: RawContractEvent[] = [];
    for (let i = 0; i < contractIds.length; i += CONTRACTS_PER_REQUEST) {
      all.push(
        ...(await this.fetchChunk(contractIds.slice(i, i + CONTRACTS_PER_REQUEST), startLedger, endLedger)),
      );
    }
    // Event ids are zero-padded TOIDs, so lexical order == chain order.
    return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async fetchChunk(contractIds: string[], startLedger: number, endLedger: number) {
    const filters: rpc.Api.EventFilter[] = [];
    for (let i = 0; i < contractIds.length; i += CONTRACTS_PER_FILTER) {
      filters.push({ type: 'contract', contractIds: contractIds.slice(i, i + CONTRACTS_PER_FILTER) });
    }
    const limit = this.opts.pageLimit;
    const out: RawContractEvent[] = [];

    // First page uses a ledger range; later pages continue by cursor. RPC treats endLedger as
    // exclusive and cursor pages are not bounded by it, so we filter to the window ourselves.
    let page = await this.retry(() =>
      this.server.getEvents({ filters, startLedger, endLedger: endLedger + 1, limit }),
    );
    for (;;) {
      let beyondWindow = false;
      for (const e of page.events) {
        if (e.ledger > endLedger) {
          beyondWindow = true;
          break;
        }
        if (e.ledger < startLedger || !e.contractId) continue;
        out.push({
          id: e.id,
          contractId: e.contractId.contractId(),
          ledger: e.ledger,
          ledgerClosedAt: e.ledgerClosedAt,
          txHash: e.txHash,
          topic: e.topic,
          value: e.value,
        });
      }
      if (beyondWindow || page.events.length < limit || !page.cursor) break;
      const cursor = page.cursor;
      page = await this.retry(() => this.server.getEvents({ filters, cursor, limit }));
    }
    return out;
  }

  async getContractWasmHash(contractId: string): Promise<string | null> {
    let entry: rpc.Api.LedgerEntryResult;
    try {
      entry = await this.retry(() =>
        this.server.getContractData(
          contractId,
          xdr.ScVal.scvLedgerKeyContractInstance(),
          rpc.Durability.Persistent,
        ),
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    if (entry.val.type !== 'contractData') return null;
    const instance = entry.val.contractData.val;
    if (instance.type !== 'scvContractInstance') return null;
    const executable = instance.instance.executable;
    return executable.type === 'contractExecutableWasm'
      ? Buffer.from(executable.wasmHash.value).toString('hex')
      : 'stellar_asset';
  }

  async getTokenBalance(token: string, holder: string): Promise<string | null> {
    const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(new Contract(token).call('balance', new Address(holder).toScVal()))
      .setTimeout(30)
      .build();
    const sim = await this.retry(() => this.server.simulateTransaction(tx));
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) return null;
    return String(scValToNative(sim.result.retval));
  }

  /** Retries transient failures (network, 5xx, 429) with exponential backoff. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    const attempts = (this.opts.retries ?? 2) + 1;
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts || isNotFound(err) || !isTransient(err)) throw err;
        await new Promise((r) => setTimeout(r, 250 * 2 ** (i - 1)));
      }
    }
  }
}

/** The SDK rejects with plain `{ code: 404, message }` objects (not Errors) for missing ledger entries. */
function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === 404) return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /not found/i.test(msg);
}

function isTransient(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  const status = e.response?.status;
  if (status !== undefined) return status === 429 || status >= 500;
  if (e.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNABORTED'].includes(e.code)) {
    return true;
  }
  return /timeout|network|socket hang up|fetch failed/i.test(e.message ?? '');
}
