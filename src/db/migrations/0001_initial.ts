import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- ---------------------------------------------------------------- auth
    CREATE TABLE auth_challenges (
      id            uuid PRIMARY KEY,
      account       text NOT NULL,
      mode          text NOT NULL CHECK (mode IN ('message', 'transaction')),
      payload       text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      consumed_at   timestamptz
    );
    CREATE INDEX auth_challenges_expires_idx ON auth_challenges (expires_at);

    CREATE TABLE refresh_tokens (
      id            uuid PRIMARY KEY,
      family_id     uuid NOT NULL,
      account       text NOT NULL,
      token_hash    text NOT NULL UNIQUE,
      created_at    timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      revoked_at    timestamptz,
      replaced_by   uuid,
      user_agent    text,
      ip            text
    );
    CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
    CREATE INDEX refresh_tokens_account_idx ON refresh_tokens (account);

    -- ---------------------------------------------------------------- treasury registry (projection of chain state)
    CREATE TABLE treasuries (
      contract_id          text PRIMARY KEY,
      network              text NOT NULL,
      name                 text,
      description          text,
      status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
      wasm_hash            text,
      registered_by        text NOT NULL,
      start_ledger         integer NOT NULL,
      last_indexed_ledger  integer NOT NULL,
      history_complete     boolean NOT NULL DEFAULT true,
      initialized_ledger   integer,
      initialized_at       timestamptz,
      admin                text,
      policy               jsonb,
      policy_version       integer,
      threshold            integer,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX treasuries_last_indexed_idx ON treasuries (last_indexed_ledger);

    CREATE TABLE treasury_members (
      contract_id   text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      account       text NOT NULL,
      role          text NOT NULL DEFAULT 'member',
      added_ledger  integer NOT NULL,
      added_at      timestamptz NOT NULL,
      PRIMARY KEY (contract_id, account)
    );
    CREATE INDEX treasury_members_account_idx ON treasury_members (account);

    CREATE TABLE treasury_recipients (
      contract_id   text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      address       text NOT NULL,
      label         text,
      added_ledger  integer NOT NULL,
      added_at      timestamptz NOT NULL,
      PRIMARY KEY (contract_id, address)
    );

    CREATE TABLE proposals (
      contract_id         text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      proposal_id         numeric(20, 0) NOT NULL,
      proposer            text NOT NULL,
      recipient           text NOT NULL,
      token               text NOT NULL,
      amount              numeric(39, 0) NOT NULL,
      department          text,
      metadata_hash       text,
      policy_version      integer NOT NULL,
      required_approvals  integer NOT NULL,
      approvals_count     integer NOT NULL DEFAULT 0,
      status              text NOT NULL CHECK (status IN ('pending', 'executed', 'cancelled')),
      expires_at          timestamptz NOT NULL,
      created_ledger      integer NOT NULL,
      created_at          timestamptz NOT NULL,
      created_tx          text NOT NULL,
      executed_by         text,
      executed_at         timestamptz,
      executed_tx         text,
      cancelled_by        text,
      cancelled_at        timestamptz,
      cancelled_tx        text,
      updated_ledger      integer NOT NULL,
      PRIMARY KEY (contract_id, proposal_id)
    );
    CREATE INDEX proposals_status_idx ON proposals (contract_id, status, proposal_id DESC);
    CREATE INDEX proposals_proposer_idx ON proposals (proposer);

    CREATE TABLE proposal_approvals (
      contract_id   text NOT NULL,
      proposal_id   numeric(20, 0) NOT NULL,
      approver      text NOT NULL,
      ledger        integer NOT NULL,
      tx_hash       text NOT NULL,
      approved_at   timestamptz NOT NULL,
      PRIMARY KEY (contract_id, proposal_id, approver),
      FOREIGN KEY (contract_id, proposal_id) REFERENCES proposals (contract_id, proposal_id) ON DELETE CASCADE
    );

    -- Off-chain, content-addressed proposal descriptions. The on-chain proposal commits to
    -- sha256(canonical JSON), so metadata cannot be swapped after the fact.
    CREATE TABLE proposal_metadata (
      contract_id    text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      metadata_hash  text NOT NULL,
      title          text NOT NULL,
      description    text NOT NULL,
      category       text,
      external_url   text,
      created_by     text NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contract_id, metadata_hash)
    );

    -- ---------------------------------------------------------------- raw event log + activity feed
    CREATE TABLE chain_events (
      id               text PRIMARY KEY,
      contract_id      text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      ledger           integer NOT NULL,
      ledger_closed_at timestamptz NOT NULL,
      tx_hash          text NOT NULL,
      event_type       text,
      topic_xdr        text[] NOT NULL,
      value_xdr        text NOT NULL,
      decode_error     text,
      ingested_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX chain_events_contract_idx ON chain_events (contract_id, id);

    CREATE TABLE activity (
      id           bigserial PRIMARY KEY,
      contract_id  text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      source       text NOT NULL CHECK (source IN ('chain', 'api')),
      type         text NOT NULL,
      actor        text,
      proposal_id  numeric(20, 0),
      event_id     text UNIQUE,
      ledger       integer,
      tx_hash      text,
      data         jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at  timestamptz NOT NULL
    );
    CREATE INDEX activity_feed_idx ON activity (contract_id, occurred_at DESC, id DESC);
    CREATE INDEX activity_actor_idx ON activity (contract_id, actor);

    -- ---------------------------------------------------------------- notifications (transactional outbox)
    CREATE TABLE notification_subscriptions (
      id                    uuid PRIMARY KEY,
      account               text NOT NULL,
      contract_id           text REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      channel               text NOT NULL CHECK (channel IN ('webhook')),
      format                text NOT NULL DEFAULT 'json' CHECK (format IN ('json', 'slack', 'discord')),
      url                   text NOT NULL,
      secret_encrypted      text NOT NULL,
      event_types           text[] NOT NULL DEFAULT '{}',
      enabled               boolean NOT NULL DEFAULT true,
      consecutive_failures  integer NOT NULL DEFAULT 0,
      disabled_reason       text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX notification_subscriptions_account_idx ON notification_subscriptions (account);

    CREATE TABLE notification_outbox (
      id             bigserial PRIMARY KEY,
      contract_id    text NOT NULL REFERENCES treasuries (contract_id) ON DELETE CASCADE,
      event_type     text NOT NULL,
      payload        jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      fanned_out_at  timestamptz
    );
    CREATE INDEX notification_outbox_pending_idx ON notification_outbox (id) WHERE fanned_out_at IS NULL;

    CREATE TABLE notification_deliveries (
      id                uuid PRIMARY KEY,
      subscription_id   uuid NOT NULL REFERENCES notification_subscriptions (id) ON DELETE CASCADE,
      outbox_id         bigint REFERENCES notification_outbox (id) ON DELETE CASCADE,
      event_type        text NOT NULL,
      payload           jsonb NOT NULL,
      status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'succeeded', 'dead')),
      attempts          integer NOT NULL DEFAULT 0,
      next_attempt_at   timestamptz NOT NULL DEFAULT now(),
      lease_expires_at  timestamptz,
      last_status_code  integer,
      last_error        text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      delivered_at      timestamptz,
      UNIQUE (subscription_id, outbox_id)
    );
    CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (next_attempt_at)
      WHERE status IN ('pending', 'in_flight');
    CREATE INDEX notification_deliveries_subscription_idx ON notification_deliveries (subscription_id, created_at DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS notification_deliveries, notification_outbox, notification_subscriptions,
      activity, chain_events, proposal_metadata, proposal_approvals, proposals,
      treasury_recipients, treasury_members, treasuries, refresh_tokens, auth_challenges CASCADE;
  `.execute(db);
}
