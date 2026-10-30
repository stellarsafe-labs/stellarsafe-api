import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAccount } from '../../plugins/auth.js';
import { cursorSchema, limitSchema } from '../../lib/pagination.js';
import { errorResponses, pageSchema } from '../../lib/schemas.js';
import { accountIdSchema, contractIdSchema } from '../../lib/stellar.js';
import type { TreasuryService } from './service.js';

export const treasurySchema = z
  .object({
    id: z.string().describe('Treasury contract ID'),
    network: z.string(),
    name: z.string().nullable(),
    description: z.string().nullable(),
    status: z
      .enum(['pending', 'active'])
      .describe('`pending` until the contract initialization event is indexed'),
    wasmHash: z.string().nullable(),
    admin: z.string().nullable(),
    policy: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('Latest indexed policy. The chain is authoritative.'),
    policyVersion: z.number().int().nullable(),
    threshold: z.number().int().nullable(),
    memberCount: z.number().int(),
    pendingProposalCount: z.number().int(),
    initializedAt: z.string().nullable(),
    initializedLedger: z.number().int().nullable(),
    registeredBy: z.string(),
    createdAt: z.string(),
    indexing: z.object({
      startLedger: z.number().int(),
      lastIndexedLedger: z.number().int(),
      historyComplete: z
        .boolean()
        .describe('False when part of the history fell outside the RPC retention window before indexing'),
    }),
  })
  .meta({ id: 'Treasury' });

const memberSchema = z
  .object({ account: z.string(), role: z.string(), addedLedger: z.number().int(), addedAt: z.string() })
  .meta({ id: 'TreasuryMember' });

const recipientSchema = z
  .object({
    address: z.string(),
    label: z.string().nullable(),
    addedLedger: z.number().int(),
    addedAt: z.string(),
  })
  .meta({ id: 'AllowlistedRecipient' });

export const idParams = z.object({ id: contractIdSchema });
const bearer = [{ bearerAuth: [] }];

export const treasuryRoutes: FastifyPluginAsyncZod<{
  treasuries: TreasuryService;
  writeLimit: number;
}> = async (app, { treasuries, writeLimit }) => {
  app.get(
    '/',
    {
      schema: {
        tags: ['treasuries'],
        summary: 'List indexed treasuries',
        querystring: z.object({
          member: accountIdSchema.optional().describe('Only treasuries where this account is a member'),
          status: z.enum(['pending', 'active']).optional(),
          limit: limitSchema,
          cursor: cursorSchema,
        }),
        response: { 200: pageSchema(treasurySchema), ...errorResponses },
      },
    },
    async (req) => treasuries.list(req.query),
  );

  app.post(
    '/',
    {
      config: { rateLimit: { max: writeLimit, timeWindow: '1 minute' } },
      onRequest: [app.authenticate],
      schema: {
        tags: ['treasuries'],
        summary: 'Register a deployed treasury contract for indexing',
        description:
          'Verifies the contract exists on the configured network (and matches a trusted WASM hash, if configured), ' +
          'then backfills its events from `startLedger` (default: oldest ledger retained by RPC).',
        security: bearer,
        body: z.object({
          contractId: contractIdSchema,
          startLedger: z.number().int().min(1).optional(),
          name: z.string().trim().min(1).max(100).optional(),
          description: z.string().trim().max(2000).optional(),
        }),
        response: { 201: treasurySchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await treasuries.register(requireAccount(req), req.body)),
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['treasuries'],
        summary: 'Get a treasury',
        params: idParams,
        response: { 200: treasurySchema, ...errorResponses },
      },
    },
    async (req) => treasuries.get(req.params.id),
  );

  app.patch(
    '/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['treasuries'],
        summary: 'Update off-chain display metadata (members only)',
        security: bearer,
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(100).nullable().optional(),
          description: z.string().trim().max(2000).nullable().optional(),
        }),
        response: { 200: treasurySchema, ...errorResponses },
      },
    },
    async (req) => treasuries.updateMetadata(requireAccount(req), req.params.id, req.body),
  );

  app.get(
    '/:id/members',
    {
      schema: {
        tags: ['treasuries'],
        summary: 'Current members (indexed from chain)',
        params: idParams,
        response: { 200: z.object({ items: z.array(memberSchema) }), ...errorResponses },
      },
    },
    async (req) => ({ items: await treasuries.members(req.params.id) }),
  );

  app.get(
    '/:id/recipients',
    {
      schema: {
        tags: ['treasuries'],
        summary: 'Allowlisted recipients (indexed from chain)',
        params: idParams,
        response: { 200: z.object({ items: z.array(recipientSchema) }), ...errorResponses },
      },
    },
    async (req) => ({ items: await treasuries.recipients(req.params.id) }),
  );

  app.get(
    '/:id/balances',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['treasuries'],
        summary: 'Live token balances read from chain',
        params: idParams,
        querystring: z.object({
          tokens: z
            .string()
            .optional()
            .describe('Comma-separated token contract IDs; defaults to tokens seen in proposals')
            .transform((v) =>
              v
                ? v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : [],
            )
            .pipe(z.array(contractIdSchema).max(20)),
        }),
        response: {
          200: z.object({
            treasuryId: z.string(),
            ledger: z.number().int(),
            balances: z.array(z.object({ token: z.string(), balance: z.string().nullable() })),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => treasuries.balances(req.params.id, req.query.tokens),
  );
};
