import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DOMAIN_EVENT_TYPE_VALUES } from '../../indexer/decoder.js';
import { requireAccount } from '../../plugins/auth.js';
import { cursorSchema, limitSchema } from '../../lib/pagination.js';
import { errorResponses, pageSchema } from '../../lib/schemas.js';
import { contractIdSchema } from '../../lib/stellar.js';
import type { NotificationService } from './service.js';

const subscriptionSchema = z
  .object({
    id: z.uuid(),
    channel: z.literal('webhook'),
    format: z.enum(['json', 'slack', 'discord']),
    url: z.string(),
    treasuryId: z.string().nullable().describe('null = all treasuries you are a member of'),
    eventTypes: z.array(z.string()).describe('Empty = all event types'),
    enabled: z.boolean(),
    consecutiveFailures: z.number().int(),
    disabledReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'NotificationSubscription' });

const withSecret = subscriptionSchema
  .extend({
    secret: z
      .string()
      .describe('HMAC signing secret. Returned only on create and rotate; store it securely.'),
  })
  .meta({ id: 'NotificationSubscriptionWithSecret' });

const deliverySchema = z
  .object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    eventType: z.string(),
    status: z.enum(['pending', 'in_flight', 'succeeded', 'dead']),
    attempts: z.number().int(),
    nextAttemptAt: z.string().nullable(),
    lastStatusCode: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
  })
  .meta({ id: 'NotificationDelivery' });

const eventTypes = z.array(z.enum(DOMAIN_EVENT_TYPE_VALUES)).max(DOMAIN_EVENT_TYPE_VALUES.length);
const format = z.enum(['json', 'slack', 'discord']);
const subParams = z.object({ id: z.uuid() });
const security = [{ bearerAuth: [] }];
const tags = ['notifications'];

export const notificationRoutes: FastifyPluginAsyncZod<{ notifications: NotificationService }> = async (
  app,
  { notifications },
) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/preferences',
    {
      schema: {
        tags,
        security,
        summary: 'List your notification subscriptions',
        response: { 200: z.object({ items: z.array(subscriptionSchema) }), ...errorResponses },
      },
    },
    async (req) => ({ items: await notifications.list(requireAccount(req)) }),
  );

  app.post(
    '/preferences',
    {
      schema: {
        tags,
        security,
        summary: 'Create a webhook subscription',
        description:
          'Deliveries are signed: `X-StellarSafe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. ' +
          'Only events from treasuries where you are a current member are delivered.',
        body: z.object({
          channel: z.literal('webhook').default('webhook'),
          url: z.string().max(2048),
          format: format.default('json'),
          treasuryId: contractIdSchema.nullable().optional(),
          eventTypes: eventTypes.default([]),
        }),
        response: { 201: withSecret, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await notifications.create(requireAccount(req), req.body)),
  );

  app.patch(
    '/preferences/:id',
    {
      schema: {
        tags,
        security,
        summary: 'Update a subscription (re-enabling resets the failure counter)',
        params: subParams,
        body: z.object({
          url: z.string().max(2048).optional(),
          format: format.optional(),
          eventTypes: eventTypes.optional(),
          enabled: z.boolean().optional(),
        }),
        response: { 200: subscriptionSchema, ...errorResponses },
      },
    },
    async (req) => notifications.update(requireAccount(req), req.params.id, req.body),
  );

  app.delete(
    '/preferences/:id',
    {
      schema: {
        tags,
        security,
        summary: 'Delete a subscription',
        params: subParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await notifications.remove(requireAccount(req), req.params.id);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/preferences/:id/rotate-secret',
    {
      schema: {
        tags,
        security,
        summary: 'Rotate the signing secret',
        params: subParams,
        response: { 200: withSecret, ...errorResponses },
      },
    },
    async (req) => notifications.rotateSecret(requireAccount(req), req.params.id),
  );

  app.post(
    '/preferences/:id/test',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags,
        security,
        summary: 'Queue a signed `ping` delivery',
        params: subParams,
        response: { 202: z.object({ deliveryId: z.uuid() }), ...errorResponses },
      },
    },
    async (req, reply) =>
      reply.status(202).send(await notifications.sendTest(requireAccount(req), req.params.id)),
  );

  app.get(
    '/deliveries',
    {
      schema: {
        tags,
        security,
        summary: 'Delivery log for your subscriptions',
        querystring: z.object({
          subscriptionId: z.uuid().optional(),
          status: z.enum(['pending', 'in_flight', 'succeeded', 'dead']).optional(),
          limit: limitSchema,
          cursor: cursorSchema,
        }),
        response: { 200: pageSchema(deliverySchema), ...errorResponses },
      },
    },
    async (req) => notifications.deliveries(requireAccount(req), req.query),
  );
};
