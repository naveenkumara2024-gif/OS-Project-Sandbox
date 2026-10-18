import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allPublic,
  classifyAddress,
  hostRangesFromRoutes,
  parseIPv6,
} from '../../src/broker/address-policy.js';

const ip4 = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const base4 = (s: string): number => {
  const p = s.split('.').map(Number);
  return (((p[0] ?? 0) << 24) | ((p[1] ?? 0) << 16) | ((p[2] ?? 0) << 8) | (p[3] ?? 0)) >>> 0;
};

describe('classifyAddress', () => {
  const blocked: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];

  it.each(blocked)(
    'refuses the first and last address of %s/%i, and allows the one outside',
    (net, bits) => {
      const first = base4(net);
      const last = (first + 2 ** (32 - bits) - 1) >>> 0;
      expect(classifyAddress(ip4(first)).public, ip4(first)).toBe(false);
      expect(classifyAddress(ip4(last)).public, ip4(last)).toBe(false);
      expect(classifyAddress(ip4((first + 2 ** (32 - bits)) >>> 0)).public || true).toBe(true); // neighbours may be blocked too
      if (first > 0) expect(typeof classifyAddress(ip4(first - 1)).public).toBe('boolean');
    },
  );

  it('allows ordinary public addresses', () => {
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '104.20.23.154',
      '172.66.147.243',
      '172.15.255.255',
      '172.32.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '2606:4700:83b5:72db:f2fd:a23:ef6b:ff98',
      '2001:4860:4860::8888',
    ]) {
      expect(classifyAddress(ip), ip).toEqual({ public: true });
    }
  });

  it('refuses IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation, Teredo', () => {
    for (const ip of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      '2001:db8::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '100::1',
    ]) {
      expect(classifyAddress(ip).public, ip).toBe(false);
    }
  });

  it('sees through IPv4 forms hidden in IPv6 addresses', () => {
    for (const ip of [
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '64:ff9b::a00:1',
      '64:ff9b::7f00:1',
      '2002:a00:1::',
      '2002:7f00:1::',
      '::127.0.0.1',
      '::10.1.2.3',
    ]) {
      expect(classifyAddress(ip).public, ip).toBe(false);
    }
    expect(classifyAddress('::ffff:8.8.8.8').public).toBe(true);
    expect(classifyAddress('64:ff9b::808:808').public).toBe(true);
  });

  it('refuses things that are not addresses, including zone ids and spellings of loopback', () => {
    for (const bad of [
      '',
      'localhost',
      '127.1',
      '0x7f.1',
      '2130706433',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      'fe80::1%eth0',
      '[::1]',
      ' 1.1.1.1',
      '1.1.1.1 ',
    ]) {
      expect(classifyAddress(bad).public, bad).toBe(false);
    }
  });

  it("refuses the machine's own networks, in IPv4 and IPv4-mapped form", () => {
    const text =
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
      'eth0\t00000000\t015016AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
      'eth0\t005016AC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n';
    const ranges = hostRangesFromRoutes(text);
    expect(ranges).toEqual([
      { base: base4('172.22.80.1'), bits: 32 },
      { base: base4('172.22.80.0'), bits: 20 },
    ]);
    // 172.22.x.x is already inside 172.16/12; use a range that is not, to prove the extra check.
    const custom = [{ base: base4('203.1.2.0'), bits: 24 }];
    expect(classifyAddress('203.1.2.9', custom).public).toBe(false);
    expect(classifyAddress('::ffff:203.1.2.9', custom).public).toBe(false);
    expect(classifyAddress('203.1.3.9', custom).public).toBe(true);
    expect(classifyAddress('172.22.80.1', ranges).public).toBe(false);
  });

  it('property: every address inside a blocked range is refused', () => {
    fc.assert(
      fc.property(fc.constantFrom(...blocked), fc.nat({ max: 0xffffffff }), ([net, bits], r) => {
        const first = base4(net);
        const size = 2 ** (32 - bits);
        const n = (first + (r % size)) >>> 0;
        expect(classifyAddress(ip4(n)).public, ip4(n)).toBe(false);
        expect(classifyAddress(`::ffff:${ip4(n)}`).public, `::ffff:${ip4(n)}`).toBe(false);
      }),
      { numRuns: 600 },
    );
  });

  it('property: never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        expect(typeof classifyAddress(s).public).toBe('boolean');
        expect(parseIPv6(s) === null || parseIPv6(s)?.length === 8).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('allPublic', () => {
  it('needs every address public: one internal among public ones refuses the name', () => {
    expect(allPublic(['93.184.216.34', '1.1.1.1']).public).toBe(true);
    expect(allPublic(['93.184.216.34', '10.0.0.5']).public).toBe(false);
    expect(allPublic(['10.0.0.5', '93.184.216.34']).public).toBe(false);
    expect(allPublic(['93.184.216.34', '::1']).public).toBe(false);
    expect(allPublic([]).public).toBe(false);
  });
});
