export type WebhookFormat = 'json' | 'slack' | 'discord';

interface OutboxPayload {
  type: string;
  treasuryId: string;
  txHash?: string;
  ledger?: number;
  occurredAt?: string;
  data?: Record<string, unknown>;
}

const short = (s: unknown) =>
  typeof s === 'string' && s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : String(s);

/** One-line human summary used for chat integrations. */
export function summarize(p: OutboxPayload): string {
  const d = p.data ?? {};
  const t = short(p.treasuryId);
  switch (p.type) {
    case 'proposal.created':
      return `New payment proposal #${String(d.id)} in treasury ${t}: ${String(d.amount)} of ${short(d.token)} to ${short(d.recipient)} (needs ${String(d.required_approvals)} approvals)`;
    case 'proposal.approved':
      return `Proposal #${String(d.id)} in treasury ${t} approved by ${short(d.approver)} (${String(d.approvals)} approvals)`;
    case 'proposal.approval_revoked':
      return `Approval on proposal #${String(d.id)} in treasury ${t} revoked by ${short(d.approver)}`;
    case 'proposal.executed':
      return `Proposal #${String(d.id)} in treasury ${t} executed by ${short(d.executor)}`;
    case 'proposal.cancelled':
      return `Proposal #${String(d.id)} in treasury ${t} cancelled by ${short(d.by)}`;
    case 'member.added':
      return `${short(d.member)} was added to treasury ${t}`;
    case 'member.removed':
      return `${short(d.member)} was removed from treasury ${t}`;
    case 'policy.updated':
      return `Spending policy of treasury ${t} updated`;
    case 'ping':
      return 'StellarSafe test notification';
    default:
      return `${p.type} in treasury ${t}`;
  }
}

export function renderBody(
  format: WebhookFormat,
  deliveryId: string,
  eventType: string,
  payload: unknown,
): string {
  const p = payload as OutboxPayload;
  switch (format) {
    case 'slack':
      return JSON.stringify({ text: `[StellarSafe] ${summarize(p)}` });
    case 'discord':
      return JSON.stringify({ content: `[StellarSafe] ${summarize(p)}`, allowed_mentions: { parse: [] } });
    case 'json':
      return JSON.stringify({
        id: deliveryId,
        type: eventType,
        createdAt: new Date().toISOString(),
        payload,
      });
  }
}
