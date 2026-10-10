import { describe, expect, it } from 'vitest';
import {
  buildFbc,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  sha256Hex,
  splitName,
  validFbp,
} from './conversions-api';

// Vetores oficiais:
// https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters/
describe('Meta CAPI normalization + hashing', () => {
  it('normalizes email (trim + lowercase)', () => {
    expect(normalizeEmail('  John_Smith@Gmail.COM ')).toBe('john_smith@gmail.com');
  });

  it('hashes email to the documented vector', async () => {
    expect(await sha256Hex(normalizeEmail('John_Smith@gmail.com'))).toBe(
      '62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f',
    );
  });

  it('normalizes phone (digits only, no leading zeros)', () => {
    expect(normalizePhone('+55 (11) 99999-9999')).toBe('5511999999999');
    expect(normalizePhone('(650) 555-1212')).toBe('6505551212');
  });

  it('hashes phone to the documented vector', async () => {
    expect(await sha256Hex(normalizePhone('(650)555-1212'.replace('650', '1650')))).toBe(
      'e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176',
    );
  });

  it('hashes first name to the documented vector', async () => {
    expect(await sha256Hex(normalizeName('Mary'))).toBe(
      '6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec',
    );
  });

  it('splits full name', () => {
    expect(splitName('João Silva Souza')).toEqual({ first: 'João', last: 'Silva Souza' });
    expect(splitName('Ana')).toEqual({ first: 'Ana', last: undefined });
    expect(splitName('')).toEqual({});
  });
});

describe('fbp/fbc helpers', () => {
  it('accepts valid fbp, rejects garbage', () => {
    expect(validFbp('fb.1.1596403881668.1116446470')).toBe('fb.1.1596403881668.1116446470');
    expect(validFbp('garbage')).toBeUndefined();
    expect(validFbp(undefined)).toBeUndefined();
  });

  it('keeps valid fbc, synthesizes from fbclid', () => {
    const good = 'fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
    expect(buildFbc(good)).toBe(good);
    const synth = buildFbc(undefined, 'ABC123');
    expect(synth).toMatch(/^fb\.1\.\d+\.ABC123$/);
    expect(buildFbc(undefined, undefined)).toBeUndefined();
  });
});
