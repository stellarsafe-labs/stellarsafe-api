import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAccount } from '../../plugins/auth.js';
import { cursorSchema, limitSchema } from '../../lib/pagination.js';
import { errorResponses, pageSchema } from '../../lib/schemas.js';
import { accountIdSchema, contractIdSchema, proposalIdSchema } from '../../lib/stellar.js';
import type { ProposalService } from './service.js';

const actionSchema = z.object({ by: z.string().nullable(), at: z.string().nullable(), txHash: z.string() });

const proposalSchema = z
  .object({
    id: z.string().describe('On-chain proposal id (u64 as decimal string)'),
    treasuryId: z.string(),
    status: z.enum(['pending', 'expired', 'executed', 'cancelled']),
    proposer: z.string(),
    recipient: z.string(),
    recipientAllowlisted: z.boolean(),
    token: z.string(),
    amount: z.string().describe("Amount in the token's smallest unit (i128 as decimal string)"),
    department: z.string().nullable(),
    policyVersion: z.number().int(),
    policyOutdated: z
      .boolean()
      .describe(
        'True when the treasury policy changed after this proposal; the contract will reject execution',
      ),
    requiredApprovals: z.number().int(),
    approvalsCount: z.number().int(),
    approvals: z
      .array(
        z.object({
          approver: z.string(),
          ledger: z.number().int(),
          txHash: z.string(),
          approvedAt: z.string(),
          approverIsMember: z.boolean(),
        }),
      )
      .optional(),
    expiresAt: z.string(),
    created: z.object({ ledger: z.number().int(), at: z.string(), txHash: z.string() }),
    executed: actionSchema.nullable(),
    cancelled: actionSchema.nullable(),
    metadataHash: z.string().nullable(),
    metadata: z
      .object({
        title: z.string(),
        description: z.string(),
        category: z.string().nullable(),
        externalUrl: z.string().nullable(),
        createdBy: z.string().nullable(),
        verified: z.literal(true),
      })
      .nullable(),
  })
  .meta({ id: 'Proposal' });

const metadataSchema = z
  .object({
    metadataHash: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    externalUrl: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .meta({ id: 'ProposalMetadata' });

const idParams = z.object({ id: contractIdSchema });

export const proposalRoutes: FastifyPluginAsyncZod<{
  proposals: ProposalService;
  writeLimit: number;
}> = async (app, { proposals, writeLimit }) => {
  app.get(
    '/:id/proposals',
    {
      schema: {
        tags: ['proposals'],
        summary: 'List payment proposals',
        params: idParams,
        querystring: z.object({
          status: z.enum(['pending', 'expired', 'executed', 'cancelled']).optional(),
          proposer: accountIdSchema.optional(),
          limit: limitSchema,
          cursor: cursorSchema,
        }),
        response: { 200: pageSchema(proposalSchema), ...errorResponses },
      },
    },
    async (req) => proposals.list(req.params.id, req.query),
  );

  app.get(
    '/:id/proposals/:proposalId',
    {
      schema: {
        tags: ['proposals'],
        summary: 'Get a proposal with its approvals',
        params: z.object({ id: contractIdSchema, proposalId: proposalIdSchema }),
        response: { 200: proposalSchema, ...errorResponses },
      },
    },
    async (req) => proposals.get(req.params.id, req.params.proposalId),
  );

  app.post(
    '/:id/proposal-metadata',
    {
      config: { rateLimit: { max: writeLimit * 3, timeWindow: '1 minute' } },
      onRequest: [app.authenticate],
      schema: {
        tags: ['proposals'],
        summary: 'Store a proposal description and get its content hash',
        description:
          'Call before proposing on-chain, then pass the returned `metadataHash` to `propose_payment`. ' +
          'Metadata is content-addressed, immutable and only linked to proposals that commit to its hash.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: z.object({
          title: z.string().trim().min(1).max(200),
          description: z.string().trim().max(10_000),
          category: z.string().trim().min(1).max(64).optional(),
          externalUrl: z
            .url({ protocol: /^https?$/ })
            .max(2048)
            .optional(),
        }),
        response: { 201: metadataSchema, ...errorResponses },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await proposals.createMetadata(requireAccount(req), req.params.id, req.body)),
  );

  app.get(
    '/:id/proposal-metadata/:hash',
    {
      schema: {
        tags: ['proposals'],
        summary: 'Get proposal metadata by content hash',
        params: z.object({ id: contractIdSchema, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
        response: { 200: metadataSchema, ...errorResponses },
      },
    },
    async (req) => proposals.getMetadata(req.params.id, req.params.hash),
  );
};
