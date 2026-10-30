import { Keypair, Networks, Transaction, WebAuth } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import {
  buildSep10Challenge,
  decodeSignature,
  sep53Digest,
  verifySep10,
  verifySep53,
  type Sep10Params,
} from '../../src/modules/auth/signatures.js';

describe('SEP-53 message signatures', () => {
  const kp = Keypair.random();
  const message = 'example.com wants you to sign in\nNonce: 123';
  const sig = Buffer.from(kp.sign(sep53Digest(message)));

  it('accepts base64 and hex signatures', () => {
    expect(verifySep53(kp.publicKey(), message, sig.toString('base64'))).toBe(true);
    expect(verifySep53(kp.publicKey(), message, sig.toString('hex'))).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    expect(verifySep53(kp.publicKey(), `${message}!`, sig.toString('base64'))).toBe(false);
  });

  it('rejects a signature from another key', () => {
    expect(verifySep53(Keypair.random().publicKey(), message, sig.toString('base64'))).toBe(false);
  });

  it('rejects raw (unprefixed) message signatures', () => {
    const raw = Buffer.from(kp.sign(Buffer.from(message)));
    expect(verifySep53(kp.publicKey(), message, raw.toString('base64'))).toBe(false);
  });

  it('rejects malformed signatures', () => {
    expect(decodeSignature('abc')).toBeNull();
    expect(verifySep53(kp.publicKey(), message, 'not a signature')).toBe(false);
    expect(verifySep53('GINVALID', message, sig.toString('base64'))).toBe(false);
  });
});

describe('SEP-10 challenge transactions', () => {
  const params: Sep10Params = {
    serverKeypair: Keypair.random(),
    networkPassphrase: Networks.TESTNET,
    homeDomain: 'api.stellarsafe.test',
    webAuthDomain: 'api.stellarsafe.test',
  };
  const client = Keypair.random();

  const signed = (xdr: string, ...signers: Keypair[]) => {
    const tx = new Transaction(xdr, params.networkPassphrase);
    for (const s of signers) tx.sign(s);
    return tx.toXDR();
  };

  it('verifies a challenge signed by the client', () => {
    const challenge = buildSep10Challenge(params, client.publicKey(), 300);
    expect(verifySep10(params, challenge, signed(challenge, client), client.publicKey())).toBe(true);
  });

  it('rejects an unsigned challenge', () => {
    const challenge = buildSep10Challenge(params, client.publicKey(), 300);
    expect(verifySep10(params, challenge, challenge, client.publicKey())).toBe(false);
  });

  it('rejects a challenge signed by someone else', () => {
    const challenge = buildSep10Challenge(params, client.publicKey(), 300);
    expect(verifySep10(params, challenge, signed(challenge, Keypair.random()), client.publicKey())).toBe(
      false,
    );
  });

  it('rejects a different (attacker-built) challenge for the same account', () => {
    const issued = buildSep10Challenge(params, client.publicKey(), 300);
    const other = buildSep10Challenge(params, client.publicKey(), 300);
    expect(verifySep10(params, issued, signed(other, client), client.publicKey())).toBe(false);
  });

  it('rejects a challenge issued by another server key', () => {
    const foreign = WebAuth.buildChallengeTx(
      Keypair.random(),
      client.publicKey(),
      params.homeDomain,
      300,
      params.networkPassphrase,
      params.webAuthDomain,
    );
    expect(verifySep10(params, foreign, signed(foreign, client), client.publicKey())).toBe(false);
  });

  it('rejects garbage', () => {
    expect(verifySep10(params, 'AAAA', 'AAAA', client.publicKey())).toBe(false);
  });
});
