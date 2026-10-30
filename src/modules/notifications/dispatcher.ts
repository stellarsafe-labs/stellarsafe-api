import { sql } from 'kysely';
import type { DB } from '../../db/index.js';
import type { SecretBox } from '../../lib/crypto.js';
import type { Logger } from '../../lib/logger.js';
import { notificationDeliveries } from '../../lib/metrics.js';
import { renderBody, renderEmail, renderVerificationEmail, type WebhookFormat } from './formats.js';
import type { Mailer } from './mailer.js';
import type { WebhookResult, WebhookSender } from './sender.js';
import { EMAIL_VERIFICATION_EVENT, unsubscribeTokenFor } from './service.js';

export interface DispatcherOptions {
  pollIntervalMs: number;
  maxAttempts: number;
  timeoutMs: number;
  disableAfterFailures: number;
  allowPrivateTargets: boolean;
  /** Required for email subscriptions; without it email deliveries are dead-lettered. */
  mailer?: Mailer | undefined;
  publicUrl: string;
  batchSize?: number;
  concurrency?: number;
}

/** Exponential backoff with ±20% jitter: 10s, 40s, 160s, ~11m, ~43m, then capped at 6h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(10_000 * 4 ** Math.max(attempt - 1, 0), 6 * 3600_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

interface ClaimedDelivery {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  channel: 'webhook' | 'email';
  url: string | null;
  email: string | null;
  verified_at: Date | null;
  format: WebhookFormat;
  secret_encrypted: string | null;
  enabled: boolean;
}

/**
 * Transactional-outbox dispatcher. The indexer writes outbox rows in the same transaction as the
 * projection; this worker fans each row out to matching subscriptions (members only) and delivers
 * them with at-least-once semantics. Rows are claimed with `FOR UPDATE SKIP LOCKED` plus a lease,
 * so any number of workers can run concurrently and a crashed worker's claims are retried.
 */
export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;

  constructor(
    private readonly db: DB,
    private readonly box: SecretBox,
    private readonly send: WebhookSender,
    private readonly log: Logger,
    private readonly opts: DispatcherOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
    this.log.info('notification dispatcher started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 25));
    this.log.info('notification dispatcher stopped');
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), delay);
    this.timer.unref?.();
  }

  private async loop(): Promise<void> {
    this.running = true;
    let busy = false;
    try {
      const fanned = await this.fanOut();
      const delivered = await this.deliverDue();
      busy = fanned > 0 || delivered >= (this.opts.batchSize ?? 50);
    } catch (err) {
      this.log.error({ err }, 'notification dispatcher tick failed');
    } finally {
      this.running = false;
    }
    this.schedule(busy ? 0 : this.opts.pollIntervalMs);
  }

  /** Expands outbox rows into per-subscription deliveries. Returns rows processed. */
  async fanOut(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      const rows = await tx
        .selectFrom('notification_outbox')
        .select(['id', 'contract_id', 'event_type', 'payload', 'created_at'])
        .where('fanned_out_at', 'is', null)
        .orderBy('id')
        .limit(this.opts.batchSize ?? 50)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of rows) {
        await sql`
          INSERT INTO notification_deliveries (id, subscription_id, outbox_id, event_type, payload)
          SELECT gen_random_uuid(), s.id, ${row.id}, ${row.event_type}, ${JSON.stringify(row.payload)}::jsonb
          FROM notification_subscriptions s
          WHERE s.enabled
            AND (s.channel = 'webhook' OR s.verified_at IS NOT NULL)
            AND s.created_at <= ${row.created_at}
            AND (s.contract_id IS NULL OR s.contract_id = ${row.contract_id})
            AND (cardinality(s.event_types) = 0 OR ${row.event_type} = ANY (s.event_types))
            AND EXISTS (
              SELECT 1 FROM treasury_members m
              WHERE m.contract_id = ${row.contract_id} AND m.account = s.account
            )
          ON CONFLICT (subscription_id, outbox_id) DO NOTHING
        `.execute(tx);
      }
      if (rows.length > 0) {
        await tx
          .updateTable('notification_outbox')
          .set({ fanned_out_at: new Date() })
          .where(
            'id',
            'in',
            rows.map((r) => r.id),
          )
          .execute();
      }
      return rows.length;
    });
  }

  /** Claims due deliveries and sends them. Returns the number attempted. */
  async deliverDue(): Promise<number> {
    const leaseMs = this.opts.timeoutMs * 2 + 10_000;
    const claimed = await sql<ClaimedDelivery>`
      WITH due AS (
        SELECT d.id FROM notification_deliveries d
        WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
           OR (d.status = 'in_flight' AND d.lease_expires_at < now())
        ORDER BY d.next_attempt_at
        LIMIT ${this.opts.batchSize ?? 50}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE notification_deliveries d
      SET status = 'in_flight',
          attempts = d.attempts + 1,
          lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
      FROM due, notification_subscriptions s
      WHERE d.id = due.id AND s.id = d.subscription_id
      RETURNING d.id, d.subscription_id, d.event_type, d.payload, d.attempts,
                s.channel, s.url, s.email, s.verified_at, s.format, s.secret_encrypted, s.enabled
    `.execute(this.db);

    const queue = [...claimed.rows];
    const workers = Array.from({ length: Math.min(this.opts.concurrency ?? 8, queue.length) }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) await this.deliverOne(d);
    });
    await Promise.all(workers);
    return claimed.rows.length;
  }

  private async deliverOne(d: ClaimedDelivery): Promise<void> {
    if (!d.enabled) {
      await this.markDead(d, null, 'subscription disabled', false);
      return;
    }
    if (d.channel === 'email') {
      if (!this.opts.mailer) {
        await this.markDead(d, null, 'email is not configured on this server', false);
        return;
      }
      if (!d.verified_at && d.event_type !== EMAIL_VERIFICATION_EVENT) {
        await this.markDead(d, null, 'email address is not verified', false);
        return;
      }
    }
    let result: WebhookResult;
    try {
      result = d.channel === 'email' ? await this.sendEmail(d) : await this.sendHook(d);
    } catch (err) {
      result = { ok: false, statusCode: null, error: (err as Error).message, retryAfter: null };
    }

    if (result.ok) {
      notificationDeliveries.inc({ result: 'success' });
      await this.db.transaction().execute(async (tx) => {
        await tx
          .updateTable('notification_deliveries')
          .set({
            status: 'succeeded',
            delivered_at: new Date(),
            last_status_code: result.statusCode,
            last_error: null,
            lease_expires_at: null,
          })
          .where('id', '=', d.id)
          .execute();
        await tx
          .updateTable('notification_subscriptions')
          .set({ consecutive_failures: 0 })
          .where('id', '=', d.subscription_id)
          .execute();
      });
      return;
    }

    notificationDeliveries.inc({ result: 'failure' });
    // 410 Gone is the receiver telling us to stop: disable immediately.
    if (result.statusCode === 410) {
      await this.markDead(d, 410, result.error, true, 'endpoint returned 410 Gone');
      return;
    }
    if (d.attempts >= this.opts.maxAttempts) {
      await this.markDead(d, result.statusCode, result.error, true);
      return;
    }
    const delay = Math.max(backoffMs(d.attempts), (result.retryAfter ?? 0) * 1000);
    await this.db
      .updateTable('notification_deliveries')
      .set({
        status: 'pending',
        next_attempt_at: new Date(Date.now() + delay),
        last_status_code: result.statusCode,
        last_error: result.error?.slice(0, 500) ?? null,
        lease_expires_at: null,
      })
      .where('id', '=', d.id)
      .execute();
  }

  private sendHook(d: ClaimedDelivery): Promise<WebhookResult> {
    return this.send({
      url: d.url!,
      body: renderBody(d.format, d.id, d.event_type, d.payload),
      secret: this.box.open(d.secret_encrypted!),
      eventType: d.event_type,
      deliveryId: d.id,
      timeoutMs: this.opts.timeoutMs,
      allowPrivate: this.opts.allowPrivateTargets,
    });
  }

  private async sendEmail(d: ClaimedDelivery): Promise<WebhookResult> {
    const message =
      d.event_type === EMAIL_VERIFICATION_EVENT
        ? renderVerificationEmail(
            this.opts.publicUrl,
            this.box.open((d.payload as { tokenSealed: string }).tokenSealed),
          )
        : renderEmail(d.event_type, d.payload, {
            publicUrl: this.opts.publicUrl,
            unsubscribeToken: unsubscribeTokenFor(this.box, d.subscription_id),
          });
    await this.opts.mailer!({ to: d.email!, ...message });
    return { ok: true, statusCode: null, error: null, retryAfter: null };
  }

  private async markDead(
    d: ClaimedDelivery,
    statusCode: number | null,
    error: string | null,
    countFailure: boolean,
    disableReason?: string,
  ): Promise<void> {
    notificationDeliveries.inc({ result: 'dead' });
    await this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('notification_deliveries')
        .set({
          status: 'dead',
          last_status_code: statusCode,
          last_error: error?.slice(0, 500) ?? null,
          lease_expires_at: null,
        })
        .where('id', '=', d.id)
        .execute();
      if (!countFailure) return;
      const sub = await tx
        .updateTable('notification_subscriptions')
        .set((eb) => ({ consecutive_failures: eb('consecutive_failures', '+', 1) }))
        .where('id', '=', d.subscription_id)
        .returning('consecutive_failures')
        .executeTakeFirst();
      const reason =
        disableReason ??
        (sub && sub.consecutive_failures >= this.opts.disableAfterFailures
          ? `disabled after ${sub.consecutive_failures} consecutive failed deliveries`
          : undefined);
      if (reason) {
        await tx
          .updateTable('notification_subscriptions')
          .set({ enabled: false, disabled_reason: reason, updated_at: new Date() })
          .where('id', '=', d.subscription_id)
          .execute();
        this.log.warn({ subscriptionId: d.subscription_id, reason }, 'webhook subscription disabled');
      }
    });
  }
}
