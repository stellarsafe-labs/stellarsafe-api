import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { requireAccount } from '../../plugins/auth.js';
import { errorResponses } from '../../lib/schemas.js';
import { accountIdSchema } from '../../lib/stellar.js';
import type { AuthService } from './service.js';

const tokenPairSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    expiresIn: z.number().int().describe('Access token lifetime in seconds'),
    refreshToken: z.string(),
    refreshExpiresIn: z.number().int(),
    account: z.string(),
  })
  .meta({ id: 'TokenPair' });

const challengeSchema = z
  .object({
    challengeId: z.uuid(),
    mode: z.enum(['message', 'transaction']),
    account: z.string(),
    message: z.string().optional().describe('Sign with SEP-53 `signMessage` (mode=message)'),
    transaction: z.string().optional().describe('SEP-10 challenge XDR to sign (mode=transaction)'),
    networkPassphrase: z.string(),
    expiresAt: z.string(),
  })
  .meta({ id: 'AuthChallenge' });

export const authRoutes: FastifyPluginAsyncZod<{ auth: AuthService; config: Config }> = async (
  app,
  { auth, config },
) => {
  const strict = { rateLimit: { max: config.RATE_LIMIT_AUTH_MAX, timeWindow: '1 minute' } };
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
  });

  app.post(
    '/challenge',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Create a wallet sign-in challenge',
        description:
          'Returns a one-time challenge. `message` mode is signed with SEP-53 (`signMessage` in Freighter and most wallets). ' +
          '`transaction` mode returns a SEP-10 challenge transaction (hardware wallets). Challenges are single-use and short-lived.',
        body: z.object({
          account: accountIdSchema,
          mode: z.enum(['message', 'transaction']).default('message'),
        }),
        response: { 201: challengeSchema, ...errorResponses },
      },
    },
    async (req, reply) => reply.status(201).send(await auth.createChallenge(req.body.account, req.body.mode)),
  );

  app.post(
    '/verify',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Exchange a signed challenge for tokens',
        body: z
          .object({
            challengeId: z.uuid(),
            signature: z
              .string()
              .max(200)
              .optional()
              .describe('base64 or hex ed25519 signature (mode=message)'),
            signedTransaction: z
              .string()
              .max(10_000)
              .optional()
              .describe('Signed challenge XDR (mode=transaction)'),
          })
          .refine((b) => b.signature || b.signedTransaction, 'signature or signedTransaction is required'),
        response: { 200: tokenPairSchema, ...errorResponses },
      },
    },
    async (req) => auth.verifyChallenge(req.body.challengeId, req.body, meta(req)),
  );

  app.post(
    '/refresh',
    {
      config: strict,
      schema: {
        tags: ['auth'],
        summary: 'Rotate a refresh token',
        description: 'Refresh tokens are single-use. Presenting a rotated token revokes the whole session.',
        body: z.object({ refreshToken: z.string().min(1).max(200) }),
        response: { 200: tokenPairSchema, ...errorResponses },
      },
    },
    async (req) => auth.refresh(req.body.refreshToken, meta(req)),
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke a session',
        body: z.object({ refreshToken: z.string().min(1).max(200) }),
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      await auth.logout(req.body.refreshToken);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ['auth'],
        summary: 'Current session',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ account: z.string() }), ...errorResponses },
      },
    },
    async (req) => ({ account: requireAccount(req) }),
  );

  app.get(
    '/config',
    {
      schema: {
        tags: ['auth'],
        summary: 'Supported sign-in modes',
        response: {
          200: z.object({
            modes: z.array(z.enum(['message', 'transaction'])),
            homeDomain: z.string(),
            networkPassphrase: z.string(),
            sep10ServerAccount: z.string().nullable(),
          }),
        },
      },
    },
    async () => ({
      modes: auth.supportedModes,
      homeDomain: config.authHomeDomain,
      networkPassphrase: config.networkPassphrase,
      sep10ServerAccount: auth.sep10ServerAccount,
    }),
  );
};
