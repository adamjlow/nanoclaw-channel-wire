import { describe, expect, it } from 'vitest';

import {
  decodeCryptoKey,
  describeError,
  isValidCryptoKeyHex,
  parseQualifiedKey,
  qualifiedKey,
  redact,
  sameQualifiedId,
} from './wire-protocol.js';

const UUID = '0b9f3c2e-7a41-4d3e-9c55-2f1e8d6a4b10';

describe('qualified ids', () => {
  it('round-trips id@domain, lowercased', () => {
    const key = qualifiedKey({ id: UUID.toUpperCase(), domain: 'Wire.COM' });
    expect(key).toBe(`${UUID}@wire.com`);
    expect(parseQualifiedKey(key)).toEqual({ id: UUID, domain: 'wire.com' });
  });

  it('accepts the wire: user-handle prefix', () => {
    expect(parseQualifiedKey(`wire:${UUID}@staging.zinfra.io`)).toEqual({ id: UUID, domain: 'staging.zinfra.io' });
  });

  it('rejects malformed keys', () => {
    for (const bad of ['', UUID, `${UUID}@`, `@wire.com`, `a@b@c`, `slack:${UUID}@wire.com`, `a b@wire.com`]) {
      expect(parseQualifiedKey(bad)).toBeNull();
    }
  });

  it('compares across case, keeping the domain significant', () => {
    expect(sameQualifiedId({ id: UUID, domain: 'wire.com' }, { id: UUID.toUpperCase(), domain: 'WIRE.com' })).toBe(
      true,
    );
    expect(sameQualifiedId({ id: UUID, domain: 'wire.com' }, { id: UUID, domain: 'other.example' })).toBe(false);
  });
});

describe('crypto key', () => {
  it('decodes exactly 64 hex characters to 32 bytes', () => {
    const hex = 'ab'.repeat(32);
    expect(isValidCryptoKeyHex(hex)).toBe(true);
    expect(decodeCryptoKey(` ${hex}\n`)).toHaveLength(32);
  });

  it('rejects short, long and non-hex keys instead of silently truncating', () => {
    for (const bad of ['ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32)]) {
      expect(isValidCryptoKeyHex(bad)).toBe(false);
      expect(() => decodeCryptoKey(bad)).toThrow(/64 hex/);
    }
  });

  it('never echoes the key in its error', () => {
    const bad = 'zz'.repeat(32);
    expect(() => decodeCryptoKey(bad)).toThrow(expect.not.objectContaining({ message: expect.stringContaining(bad) }));
  });
});

describe('redact', () => {
  it('masks uuids (keeping a prefix), emails and bearer tokens', () => {
    const out = redact(`user ${UUID}@wire.com mailed alice@example.com with Bearer abcdefghijklmnop`);
    expect(out).not.toContain(UUID);
    expect(out).toContain('0b9f…@wire.com');
    expect(out).not.toContain('alice@example.com');
    expect(out).toContain('<email>');
    expect(out).not.toContain('abcdefghijklmnop');
  });

  it('describes errors on one redacted line', () => {
    const err = new Error(`failed for\n${UUID}`);
    expect(describeError(err)).toBe('Error: failed for 0b9f…');
  });
});
