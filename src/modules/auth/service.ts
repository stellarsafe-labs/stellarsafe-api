import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { Config } from '../../config.js';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/index.js';
import type { Database } from '../../db/schema.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { buildSep10Challenge, verifySep10, verifySep53, type Sep10Params } from './signatures.js';

export type ChallengeMode = 'message' | 'transaction';

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  account: string;
}

export interface AccessClaims {
  account: string;
  tokenId: string;
}

const AUDIENCE = 'stellarsafe';

export class AuthService {
  private readonly jwtKey: Uint8Array;
  private readonly sep10: Sep10Params | null;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
  ) {
    this.jwtKey = new TextEncoder().encode(config.JWT_SECRET);
    this.sep10 = config.SEP10_SIGNING_SECRET
      ? {
          serverKeypair: Keypair.fromSecret(config.SEP10_SIGNING_SECRET),
          networkPassphrase: config.networkPassphrase,
          homeDomain: config.authHomeDomain,
          webAuthDomain: new URL(config.PUBLIC_URL).host,
        }
      : null;
  }

  get supportedModes(): ChallengeMode[] {
    return this.sep10 ? ['message', 'transaction'] : ['message'];
  }

  get sep10ServerAccount(): string | null {
    return this.sep10?.serverKeypair.publicKey() ?? null;
  }

  async createChallenge(account: string, mode: ChallengeMode) {
    const id = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.config.AUTH_CHALLENGE_TTL_SECONDS * 1000);

    let payload: string;
    if (mode === 'transaction') {
      if (!this.sep10) throw badRequest('Transaction (SEP-10) challenges are not enabled on this server');
      payload = buildSep10Challenge(this.sep10, account, this.config.AUTH_CHALLENGE_TTL_SECONDS);
    } else {
      payload = this.buildMessage(account, id, issuedAt, expiresAt);
    }

    await this.db
      .insertInto('auth_challenges')
      .values({ id, account, mode, payload, created_at: issuedAt, expires_at: expiresAt })
      .execute();

    return {
      challengeId: id,
      mode,
      account,
      ...(mode === 'message' ? { message: payload } : { transaction: payload }),
      networkPassphrase: this.config.networkPassphrase,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** SIWE-style, human-readable sign-in message (signed via SEP-53 `signMessage`). */
  private buildMessage(account: string, nonce: string, issuedAt: Date, expiresAt: Date): string {
    return [
      `${this.config.authHomeDomain} wants you to sign in with your Stellar account:`,
      account,
      '',
      'Sign in to StellarSafe. This does not submit a transaction, move funds or cost fees.',
      '',
      `URI: ${this.config.PUBLIC_URL}`,
      `Network: ${this.config.networkPassphrase}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join('\n');
  }

  async verifyChallenge(
    challengeId: string,
    proof: { signature?: string | undefined; signedTransaction?: string | undefined },
    meta: ClientMeta,
  ): Promise<TokenPair> {
    const challenge = await this.db
      .selectFrom('auth_challenges')
      .selectAll()
      .where('id', '=', challengeId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    if (!challenge) throw unauthorized('Challenge is invalid, expired or already used');

    let valid: boolean;
    if (challenge.mode === 'message') {
      if (!proof.signature) throw badRequest('signature is required for message challenges');
      valid = verifySep53(challenge.account, challenge.payload, proof.signature);
    } else {
      if (!proof.signedTransaction)
        throw badRequest('signedTransaction is required for transaction challenges');
      valid =
        !!this.sep10 &&
        verifySep10(this.sep10, challenge.payload, proof.signedTransaction, challenge.account);
    }
    if (!valid) throw unauthorized('Signature verification failed');

    // Single use: only the first concurrent verifier wins.
    const consumed = await this.db
      .updateTable('auth_challenges')
      .set({ consumed_at: new Date() })
      .where('id', '=', challengeId)
      .where('consumed_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!consumed) throw unauthorized('Challenge is invalid, expired or already used');

    return (await this.issueTokens(challenge.account, randomUUID(), meta)).tokens;
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<TokenPair> {
    const hash = sha256Hex(refreshToken);
    const result = await this.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('refresh_tokens')
        .selectAll()
        .where('token_hash', '=', hash)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw unauthorized('Invalid refresh token');
      // Reuse is handled after this transaction so the revocation is not rolled back.
      if (row.revoked_at) return { kind: 'reused', familyId: row.family_id } as const;
      if (row.expires_at <= new Date()) throw unauthorized('Refresh token expired');

      const pair = await this.issueTokens(row.account, row.family_id, meta, tx);
      await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date(), replaced_by: pair.refreshTokenId })
        .where('id', '=', row.id)
        .execute();
      return { kind: 'ok', tokens: pair.tokens } as const;
    });

    if (result.kind === 'reused') {
      // A rotated token was presented again: assume theft and kill the whole session family.
      await this.revokeFamily(result.familyId);
      throw unauthorized('Refresh token reuse detected; session revoked');
    }
    return result.tokens;
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async logout(refreshToken: string): Promise<void> {
    const row = await this.db
      .selectFrom('refresh_tokens')
      .select('family_id')
      .where('token_hash', '=', sha256Hex(refreshToken))
      .executeTakeFirst();
    if (row) await this.revokeFamily(row.family_id);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.config.JWT_ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string')
        throw unauthorized('Invalid token');
      return { account: payload.sub, tokenId: payload.jti };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw unauthorized('Access token expired');
      throw unauthorized('Invalid access token');
    }
  }

  private async issueTokens(
    account: string,
    familyId: string,
    meta: ClientMeta,
    executor: Kysely<Database> = this.db,
  ): Promise<{ tokens: TokenPair; refreshTokenId: string }> {
    const ttl = this.config.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(account)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .setJti(randomUUID())
      .sign(this.jwtKey);

    const refreshToken = randomToken(32);
    const refreshTokenId = randomUUID();
    await executor
      .insertInto('refresh_tokens')
      .values({
        id: refreshTokenId,
        family_id: familyId,
        account,
        token_hash: sha256Hex(refreshToken),
        expires_at: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
        ip: meta.ip ?? null,
        user_agent: meta.userAgent?.slice(0, 512) ?? null,
      })
      .execute();

    const tokens: TokenPair = {
      tokenType: 'Bearer',
      accessToken,
      expiresIn: ttl,
      refreshToken,
      refreshExpiresIn: this.config.REFRESH_TOKEN_TTL_SECONDS,
      account,
    };
    return { tokens, refreshTokenId };
  }
}
