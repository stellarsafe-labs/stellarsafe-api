import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { hmacSha256Hex } from '../../lib/crypto.js';
import { guardedLookup, isPublicAddress } from './ssrf.js';

export interface WebhookRequest {
  url: string;
  body: string;
  secret: string;
  eventType: string;
  deliveryId: string;
  timeoutMs: number;
  allowPrivate: boolean;
}

export interface WebhookResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  /** Seconds from a Retry-After header, if the receiver sent one. */
  retryAfter: number | null;
}

export type WebhookSender = (req: WebhookRequest) => Promise<WebhookResult>;

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Stripe-style signature: `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export const sendWebhook: WebhookSender = (req) =>
  new Promise((resolve) => {
    const done = (r: Partial<WebhookResult>) =>
      resolve({ ok: false, statusCode: null, error: null, retryAfter: null, ...r });

    const url = new URL(req.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!req.allowPrivate && isIP(host) && !isPublicAddress(host)) {
      return done({ error: 'Refusing to connect to non-public address' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'POST',
        lookup: guardedLookup(req.allowPrivate),
        timeout: req.timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(req.body),
          'user-agent': 'StellarSafe-Webhooks/1.0',
          'x-stellarsafe-event': req.eventType,
          'x-stellarsafe-delivery': req.deliveryId,
          'x-stellarsafe-signature': signPayload(req.secret, req.body, timestamp),
        },
      },
      (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) res.destroy();
        });
        const finish = () => {
          const status = res.statusCode ?? 0;
          const retryAfterHeader = Number(res.headers['retry-after']);
          done({
            ok: status >= 200 && status < 300,
            statusCode: status,
            error: status >= 200 && status < 300 ? null : `HTTP ${status}`,
            retryAfter: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : null,
          });
        };
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timed out after ${req.timeoutMs}ms`)));
    request.on('error', (err) => done({ error: err.message }));
    request.end(req.body);
  });
