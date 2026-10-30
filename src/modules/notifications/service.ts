import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { DB } from '../../db/index.js';
import type { Subscription } from '../../db/schema.js';
import { randomToken, type SecretBox } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import type { TreasuryService } from '../treasuries/service.js';
import type { WebhookFormat } from './formats.js';
import { assertWebhookUrl } from './ssrf.js';

const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
const deliveriesCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface CreateSubscriptionInput {
  url: string;
  format: WebhookFormat;
  treasuryId?: string | null | undefined;
  eventTypes: string[];
}

export interface UpdateSubscriptionInput {
  url?: string | undefined;
  format?: WebhookFormat | undefined;
  eventTypes?: string[] | undefined;
  enabled?: boolean | undefined;
}

export class NotificationService {
  constructor(
    private readonly db: DB,
    private readonly treasuries: TreasuryService,
    private readonly box: SecretBox,
    private readonly config: Config,
  ) {}

  private get urlPolicy() {
    return { allowPrivate: this.config.NOTIFY_ALLOW_PRIVATE_TARGETS, requireHttps: this.config.isProduction };
  }

  async list(account: string) {
    const rows = await this.db
      .selectFrom('notification_subscriptions')
      .selectAll()
      .where('account', '=', account)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toDto);
  }

  async create(account: string, input: CreateSubscriptionInput) {
    assertWebhookUrl(input.url, this.urlPolicy);
    if (input.treasuryId) await this.treasuries.assertMember(input.treasuryId, account);

    const count = await this.db
      .selectFrom('notification_subscriptions')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('account', '=', account)
      .executeTakeFirstOrThrow();
    if (Number(count.c) >= MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
      throw badRequest(`At most ${MAX_SUBSCRIPTIONS_PER_ACCOUNT} subscriptions per account`);
    }

    const secret = `whsec_${randomToken(32)}`;
    const row = await this.db
      .insertInto('notification_subscriptions')
      .values({
        id: randomUUID(),
        account,
        contract_id: input.treasuryId ?? null,
        channel: 'webhook',
        format: input.format,
        url: input.url,
        secret_encrypted: this.box.seal(secret),
        event_types: [...new Set(input.eventTypes)],
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toDto(row), secret };
  }

  private async own(account: string, id: string): Promise<Subscription> {
    const row = await this.db
      .selectFrom('notification_subscriptions')
      .selectAll()
      .where('id', '=', id)
      .where('account', '=', account)
      .executeTakeFirst();
    if (!row) throw notFound('Subscription');
    return row;
  }

  async update(account: string, id: string, input: UpdateSubscriptionInput) {
    await this.own(account, id);
    if (input.url !== undefined) assertWebhookUrl(input.url, this.urlPolicy);
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.format !== undefined ? { format: input.format } : {}),
        ...(input.eventTypes !== undefined ? { event_types: [...new Set(input.eventTypes)] } : {}),
        ...(input.enabled !== undefined
          ? {
              enabled: input.enabled,
              ...(input.enabled ? { consecutive_failures: 0, disabled_reason: null } : {}),
            }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDto(row);
  }

  async remove(account: string, id: string): Promise<void> {
    await this.own(account, id);
    await this.db.deleteFrom('notification_subscriptions').where('id', '=', id).execute();
  }

  async rotateSecret(account: string, id: string) {
    await this.own(account, id);
    const secret = `whsec_${randomToken(32)}`;
    const row = await this.db
      .updateTable('notification_subscriptions')
      .set({ secret_encrypted: this.box.seal(secret), updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...toDto(row), secret };
  }

  /** Queues a `ping` delivery that goes through the normal dispatcher (signing, retries, logs). */
  async sendTest(account: string, id: string) {
    const sub = await this.own(account, id);
    const deliveryId = randomUUID();
    await this.db
      .insertInto('notification_deliveries')
      .values({
        id: deliveryId,
        subscription_id: sub.id,
        outbox_id: null,
        event_type: 'ping',
        payload: JSON.stringify({
          type: 'ping',
          treasuryId: sub.contract_id,
          data: { subscriptionId: sub.id },
        }),
        created_at: new Date(),
      })
      .execute();
    return { deliveryId };
  }

  async deliveries(
    account: string,
    opts: {
      subscriptionId?: string | undefined;
      status?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    const after = decodeCursor(opts.cursor, deliveriesCursor);
    let q = this.db
      .selectFrom('notification_deliveries as d')
      .innerJoin('notification_subscriptions as s', 's.id', 'd.subscription_id')
      .selectAll('d')
      .where('s.account', '=', account);
    if (opts.subscriptionId) q = q.where('d.subscription_id', '=', opts.subscriptionId);
    if (opts.status) q = q.where('d.status', '=', opts.status as 'pending');
    if (after) {
      const [at, id] = after;
      q = q.where((eb) =>
        eb.or([
          eb('d.created_at', '<', new Date(at)),
          eb.and([eb('d.created_at', '=', new Date(at)), eb('d.id', '<', id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(opts.limit + 1)
      .execute();
    const page = paginate(rows, opts.limit, (r) => [r.created_at.toISOString(), r.id]);
    return {
      items: page.items.map((d) => ({
        id: d.id,
        subscriptionId: d.subscription_id,
        eventType: d.event_type,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.status === 'pending' ? d.next_attempt_at.toISOString() : null,
        lastStatusCode: d.last_status_code,
        lastError: d.last_error,
        createdAt: d.created_at.toISOString(),
        deliveredAt: d.delivered_at?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }
}

function toDto(s: Subscription) {
  return {
    id: s.id,
    channel: s.channel,
    format: s.format,
    url: s.url,
    treasuryId: s.contract_id,
    eventTypes: s.event_types,
    enabled: s.enabled,
    consecutiveFailures: s.consecutive_failures,
    disabledReason: s.disabled_reason,
    createdAt: s.created_at.toISOString(),
    updatedAt: s.updated_at.toISOString(),
  };
}
