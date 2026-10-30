import { createHash } from 'node:crypto';
import { Keypair, Transaction, WebAuth } from '@stellar/stellar-sdk';

/** SEP-53: signatures cover sha256("Stellar Signed Message:\n" + message). */
export const SEP53_PREFIX = 'Stellar Signed Message:\n';

export function sep53Digest(message: string): Buffer {
  return createHash('sha256')
    .update(Buffer.from(SEP53_PREFIX, 'utf8'))
    .update(Buffer.from(message, 'utf8'))
    .digest();
}

/** Wallets return signatures as base64 or hex. Returns null for anything that isn't 64 bytes. */
export function decodeSignature(signature: string): Buffer | null {
  const s = signature.trim();
  const buf = /^[0-9a-fA-F]{128}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return buf.length === 64 ? buf : null;
}

export function verifySep53(account: string, message: string, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return Keypair.fromPublicKey(account).verify(sep53Digest(message), sig);
  } catch {
    return false;
  }
}

export interface Sep10Params {
  serverKeypair: Keypair;
  networkPassphrase: string;
  homeDomain: string;
  webAuthDomain: string;
}

export function buildSep10Challenge(p: Sep10Params, account: string, ttlSeconds: number): string {
  return WebAuth.buildChallengeTx(
    p.serverKeypair,
    account,
    p.homeDomain,
    ttlSeconds,
    p.networkPassphrase,
    p.webAuthDomain,
  );
}

/**
 * Verifies a signed SEP-10 challenge: it must be the exact transaction we issued (same hash),
 * still within its time bounds, signed by our server key, and signed by the client account's
 * master key.
 */
export function verifySep10(p: Sep10Params, issuedXdr: string, signedXdr: string, account: string): boolean {
  try {
    const issued = new Transaction(issuedXdr, p.networkPassphrase);
    const signed = new Transaction(signedXdr, p.networkPassphrase);
    if (!Buffer.from(issued.hash()).equals(Buffer.from(signed.hash()))) return false;

    const serverAccount = p.serverKeypair.publicKey();
    const { clientAccountID } = WebAuth.readChallengeTx(
      signedXdr,
      serverAccount,
      p.networkPassphrase,
      p.homeDomain,
      p.webAuthDomain,
    );
    if (clientAccountID !== account) return false;

    const signers = WebAuth.verifyChallengeTxSigners(
      signedXdr,
      serverAccount,
      p.networkPassphrase,
      [account],
      p.homeDomain,
      p.webAuthDomain,
    );
    return signers.includes(account);
  } catch {
    return false;
  }
}
