import type { ChainClient } from '../../src/chain/chain-client.js';
import type { RawContractEvent } from '../../src/indexer/decoder.js';

/** In-memory chain: tests append events and move the ledger tip. */
export class FakeChain implements ChainClient {
  latestLedger = 1_000;
  oldestLedger = 1;
  events: RawContractEvent[] = [];
  wasmHashes = new Map<string, string>();
  balances = new Map<string, string>();
  calls: { start: number; end: number; ids: string[] }[] = [];
  failNext = 0;

  async getLedgerBounds() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('rpc unavailable');
    }
    return { latestLedger: this.latestLedger, oldestLedger: this.oldestLedger };
  }

  async getContractEvents(contractIds: string[], startLedger: number, endLedger: number) {
    this.calls.push({ start: startLedger, end: endLedger, ids: [...contractIds] });
    return this.events
      .filter((e) => contractIds.includes(e.contractId) && e.ledger >= startLedger && e.ledger <= endLedger)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async getContractWasmHash(contractId: string) {
    return this.wasmHashes.get(contractId) ?? null;
  }

  async getTokenBalance(token: string, holder: string) {
    return this.balances.get(`${token}:${holder}`) ?? null;
  }
}
