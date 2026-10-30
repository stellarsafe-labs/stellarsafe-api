import type { FastifyBaseLogger } from 'fastify';
import { pino, type LoggerOptions } from 'pino';

export type Logger = FastifyBaseLogger;

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.refreshToken',
        '*.accessToken',
        '*.secret',
        '*.signature',
        '*.signedTransaction',
      ],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
  };
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino(loggerOptions(level, pretty));
}
