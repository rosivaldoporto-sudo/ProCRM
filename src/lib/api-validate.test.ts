import { describe, expect, it } from 'vitest';
import {
  capStr,
  httpsUrl,
  isDigits,
  isUuid,
  isValidEnum,
  jsonSizeOk,
  reqStr,
  strArray,
  validEmail,
} from './api-validate';

describe('api-validate', () => {
  it('isUuid valida formato', () => {
    expect(isUuid('21cd74cc-195e-469f-9cfa-8d75c1e356cb')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(123)).toBe(false);
  });

  it('isDigits impõe tamanho e dígitos', () => {
    expect(isDigits('12345', 5, 30)).toBe(true);
    expect(isDigits('12a45')).toBe(false);
    expect(isDigits('123', 5)).toBe(false);
  });

  it('capStr/reqStr aparame impõem teto', () => {
    expect(capStr('  abc  ', 10)).toBe('abc');
    expect(capStr('abcdef', 3)).toBe('abc');
    expect(capStr('   ', 10)).toBeUndefined();
    expect(capStr(5, 10)).toBeUndefined();
    expect(reqStr('', 10)).toBeNull();
  });

  it('httpsUrl bloqueia esquemas perigosos', () => {
    expect(httpsUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('data:text/html,hi')).toBeNull();
    expect(httpsUrl('http://example.com')).toBeNull();
    expect(httpsUrl('not a url')).toBeNull();
    expect(httpsUrl('https://x/' + 'a'.repeat(5000), 2048)).toBeNull();
  });

  it('validEmail valida formato e teto', () => {
    expect(validEmail('a@b.co')).toBe('a@b.co');
    expect(validEmail('nope')).toBeNull();
    expect(validEmail('a@b')).toBeNull();
  });

  it('strArray filtra e limita', () => {
    expect(strArray(['a', 1, '  ', 'b'], 10, 5)).toEqual(['a', 'b']);
    expect(strArray(['a', 'b', 'c'], 2, 5)).toEqual(['a', 'b']);
    expect(strArray('x', 10, 5)).toBeNull();
  });

  it('isValidEnum aceita set e lista', () => {
    expect(isValidEnum('a', new Set(['a', 'b']))).toBe(true);
    expect(isValidEnum('c', ['a', 'b'])).toBe(false);
    expect(isValidEnum(1, ['a'])).toBe(false);
  });

  it('jsonSizeOk mede serializado', () => {
    expect(jsonSizeOk({ a: 1 }, 100)).toBe(true);
    expect(jsonSizeOk({ a: 'x'.repeat(1000) }, 100)).toBe(false);
    expect(jsonSizeOk(BigInt(1), 100)).toBe(false);
  });
});
