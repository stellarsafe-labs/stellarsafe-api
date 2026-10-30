import formbody from '@fastify/formbody';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotificationService } from './service.js';

/**
 * Unauthenticated email link endpoints (the token is the credential).
 *
 * GET only renders a confirmation page; the state change happens on POST. Mail security
 * scanners prefetch links, so acting on GET would let an attacker's sign-up of someone else's
 * address confirm itself. POST also serves RFC 8058 one-click unsubscribe from mail clients.
 */
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const confirmForm = (action: string, token: string, label: string) =>
  `<form method="post" action="${action}"><input type="hidden" name="token" value="${escapeAttr(token)}">` +
  `<button type="submit">${label}</button></form>`;

const token = z.string().min(10).max(200);
const tags = ['notifications'];

export const emailLinkRoutes: FastifyPluginAsyncZod<{ notifications: NotificationService }> = async (
  app,
  { notifications },
) => {
  await app.register(formbody, { bodyLimit: 2048 });

  app.get(
    '/verify',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags,
        summary: 'Email confirmation page',
        querystring: z.object({ token }),
        produces: ['text/html'],
      },
    },
    async (req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(
          page(
            'Confirm StellarSafe notifications',
            `<p>Press the button to start receiving treasury notifications at this address.</p>${confirmForm('verify', req.query.token, 'Confirm email')}`,
          ),
        ),
  );

  app.post(
    '/verify',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags,
        summary: 'Confirm an email subscription',
        body: z.object({ token }),
        produces: ['text/html'],
      },
    },
    async (req, reply) => {
      const ok = await notifications.verifyEmail(req.body.token);
      return reply
        .status(ok ? 200 : 400)
        .type('text/html; charset=utf-8')
        .send(
          ok
            ? page(
                'Email confirmed',
                '<p>You will now receive StellarSafe notifications at this address.</p>',
              )
            : page('Link invalid or expired', '<p>Request a new confirmation email from StellarSafe.</p>'),
        );
    },
  );

  app.get(
    '/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags,
        summary: 'Unsubscribe confirmation page',
        querystring: z.object({ token }),
        produces: ['text/html'],
      },
    },
    async (req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send(page('Unsubscribe', confirmForm('unsubscribe', req.query.token, 'Stop these emails'))),
  );

  app.post(
    '/unsubscribe',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags,
        summary: 'Unsubscribe (form post or RFC 8058 one-click)',
        querystring: z.object({ token: token.optional() }),
        body: z.object({ token: token.optional() }).passthrough().optional(),
        produces: ['text/html'],
      },
    },
    async (req, reply) => {
      const t = req.body?.token ?? req.query.token;
      const ok = t ? await notifications.unsubscribe(t) : false;
      return reply
        .status(ok ? 200 : 400)
        .type('text/html; charset=utf-8')
        .send(
          ok
            ? page('Unsubscribed', '<p>You will no longer receive these emails.</p>')
            : page('Link invalid', ''),
        );
    },
  );
};
