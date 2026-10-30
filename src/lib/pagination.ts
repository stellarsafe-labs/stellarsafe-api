import { z } from 'zod';
import { badRequest } from './errors.js';

export const limitSchema = z.coerce.number().int().min(1).max(100).default(25);
export const cursorSchema = z.string().max(512).optional();

/** Opaque cursors: base64url(JSON). Clients must treat them as opaque strings. */
export function encodeCursor(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends z.ZodType>(
  cursor: string | undefined,
  schema: T,
): z.infer<T> | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

/** Fetch `limit + 1` rows, then call this to split off the page and compute the next cursor. */
export function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown[]) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
