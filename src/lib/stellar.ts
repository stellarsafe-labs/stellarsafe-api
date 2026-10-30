import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

export const accountIdSchema = z
  .string()
  .trim()
  .refine((v) => StrKey.isValidEd25519PublicKey(v), 'must be a valid Stellar account (G...)')
  .describe('Stellar account ID (G...)');

export const contractIdSchema = z
  .string()
  .trim()
  .refine((v) => StrKey.isValidContract(v), 'must be a valid Soroban contract ID (C...)')
  .describe('Soroban contract ID (C...)');

/** Any Soroban `Address`: an account (G...) or a contract (C...). */
export const addressSchema = z
  .string()
  .trim()
  .refine(
    (v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
    'must be a valid Stellar address (G... or C...)',
  );

/** u64 proposal ids are exposed as decimal strings. */
export const proposalIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/, 'must be an unsigned integer')
  .refine((v) => BigInt(v) <= 18446744073709551615n, 'out of u64 range');
