import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { unauthorized } from '../lib/errors.js';
import type { AuthService } from '../modules/auth/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated Stellar account (G...). Set by `app.authenticate`. */
    account: string | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp<{ auth: AuthService }>(
  async (app: FastifyInstance, { auth }) => {
    app.decorateRequest('account', null);
    app.decorate('authenticate', async (req: FastifyRequest) => {
      const header = req.headers.authorization;
      const match = header?.match(/^Bearer\s+(\S+)$/i);
      if (!match?.[1]) throw unauthorized();
      const claims = await auth.verifyAccessToken(match[1]);
      req.account = claims.account;
    });
  },
  { name: 'auth' },
);

/** Returns the authenticated account or throws; use in handlers behind `app.authenticate`. */
export function requireAccount(req: FastifyRequest): string {
  if (!req.account) throw unauthorized();
  return req.account;
}
