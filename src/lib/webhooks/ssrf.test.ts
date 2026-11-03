import { describe, it, expect } from 'vitest';
import { isPrivateOrReservedIp, isDeliverableUrl } from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('flags every spelling of an embedded private IPv4', () => {
    for (const ip of [
      '::ffff:7f00:1', // how the URL parser rewrites ::ffff:127.0.0.1
      '::ffff:a9fe:a9fe', // ::ffff:169.254.169.254
      '[::ffff:7f00:1]',
      '::7f00:1', // IPv4-compatible
      '::ffff:0:7f00:1', // IPv4-translated
      '64:ff9b::7f00:1', // NAT64
      '64:ff9b:1::1', // NAT64 local-use
      '2002:7f00:1::', // 6to4
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('::ffff:808:808')).toBe(false); // 8.8.8.8
    expect(isPrivateOrReservedIp('64:ff9b::808:808')).toBe(false);
  });

  it('flags reserved, multicast and unparseable addresses', () => {
    for (const ip of [
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      'ff02::1',
      'fec0::1',
      '2001:db8::1',
      'not-an-ip',
      '1:2:3',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost./hook')).toBe(false);
  });

  it('rejects IPv4-mapped literals rewritten by the URL parser', async () => {
    expect(await isDeliverableUrl('http://[::ffff:127.0.0.1]/hook')).toBe(false);
    expect(await isDeliverableUrl('http://[::ffff:169.254.169.254]/')).toBe(false);
    expect(await isDeliverableUrl('http://[64:ff9b::7f00:1]/')).toBe(false);
  });

  it('rejects non-http(s) schemes', async () => {
    expect(await isDeliverableUrl('ftp://8.8.8.8/hook')).toBe(false);
    expect(await isDeliverableUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
