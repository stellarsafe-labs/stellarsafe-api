import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Process-wide Prometheus registry shared by the API and workers. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'stellarsafe_' });

export const httpRequestDuration = new Histogram({
  name: 'stellarsafe_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const indexerEvents = new Counter({
  name: 'stellarsafe_indexer_events_total',
  help: 'Contract events ingested by the indexer',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const indexerLag = new Gauge({
  name: 'stellarsafe_indexer_lag_ledgers',
  help: 'Ledgers between the RPC tip and the least-indexed treasury',
  registers: [registry],
});

export const indexerErrors = new Counter({
  name: 'stellarsafe_indexer_errors_total',
  help: 'Indexer tick failures',
  registers: [registry],
});

export const notificationDeliveries = new Counter({
  name: 'stellarsafe_notification_deliveries_total',
  help: 'Webhook delivery attempts',
  labelNames: ['result'] as const,
  registers: [registry],
});
