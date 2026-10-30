import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { cursorSchema, limitSchema } from '../../lib/pagination.js';
import { errorResponses, pageSchema } from '../../lib/schemas.js';
import { addressSchema, contractIdSchema, proposalIdSchema } from '../../lib/stellar.js';
import type { TreasuryService } from '../treasuries/service.js';
import type { ActivityService } from './service.js';

const activitySchema = z
  .object({
    id: z.string(),
    treasuryId: z.string(),
    source: z.enum(['chain', 'api']).describe('`chain` = indexed contract event; `api` = off-chain action'),
    type: z.string(),
    actor: z.string().nullable(),
    proposalId: z.string().nullable(),
    ledger: z.number().int().nullable(),
    txHash: z.string().nullable(),
    eventId: z.string().nullable(),
    data: z.unknown(),
    occurredAt: z.string(),
  })
  .meta({ id: 'Activity' });

const filters = z.object({
  type: z
    .string()
    .regex(/^[a-z_]+(\.([a-z_]+|\*))?$/)
    .optional()
    .describe('Exact type (`proposal.executed`) or prefix (`proposal.*`)'),
  actor: addressSchema.optional(),
  source: z.enum(['chain', 'api']).optional(),
  proposalId: proposalIdSchema.optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});

export const activityRoutes: FastifyPluginAsyncZod<{
  activity: ActivityService;
  treasuries: TreasuryService;
}> = async (app, { activity, treasuries }) => {
  app.get(
    '/:id/activity',
    {
      schema: {
        tags: ['activity'],
        summary: 'Audit trail: indexed on-chain events and off-chain actions, newest first',
        params: z.object({ id: contractIdSchema }),
        querystring: filters.extend({ limit: limitSchema, cursor: cursorSchema }),
        response: { 200: pageSchema(activitySchema), ...errorResponses },
      },
    },
    async (req) => {
      await treasuries.assertExists(req.params.id);
      return activity.list(req.params.id, req.query);
    },
  );

  app.get(
    '/:id/activity/export',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['activity'],
        summary: 'Export the audit trail as CSV (oldest first, max 10,000 rows)',
        params: z.object({ id: contractIdSchema }),
        querystring: filters,
        produces: ['text/csv'],
        response: { 200: z.string(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await treasuries.assertExists(req.params.id);
      const csv = await activity.exportCsv(req.params.id, req.query);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${req.params.id}-activity.csv"`)
        .send(csv);
    },
  );
};
