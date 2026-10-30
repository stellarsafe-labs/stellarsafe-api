import { sql, type Kysely } from 'kysely';

/** Adds the double opt-in email channel to notification subscriptions. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE notification_subscriptions
      DROP CONSTRAINT notification_subscriptions_channel_check,
      ADD CONSTRAINT notification_subscriptions_channel_check CHECK (channel IN ('webhook', 'email')),
      ALTER COLUMN url DROP NOT NULL,
      ALTER COLUMN secret_encrypted DROP NOT NULL,
      ADD COLUMN email text,
      ADD COLUMN verified_at timestamptz,
      ADD COLUMN verification_token_hash text UNIQUE,
      ADD COLUMN verification_expires_at timestamptz,
      ADD CONSTRAINT notification_subscriptions_target_check CHECK (
        (channel = 'webhook' AND url IS NOT NULL AND secret_encrypted IS NOT NULL)
        OR (channel = 'email' AND email IS NOT NULL)
      );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM notification_subscriptions WHERE channel = 'email';
    ALTER TABLE notification_subscriptions
      DROP CONSTRAINT notification_subscriptions_target_check,
      DROP COLUMN email,
      DROP COLUMN verified_at,
      DROP COLUMN verification_token_hash,
      DROP COLUMN verification_expires_at,
      ALTER COLUMN url SET NOT NULL,
      ALTER COLUMN secret_encrypted SET NOT NULL,
      DROP CONSTRAINT notification_subscriptions_channel_check,
      ADD CONSTRAINT notification_subscriptions_channel_check CHECK (channel IN ('webhook'));
  `.execute(db);
}
