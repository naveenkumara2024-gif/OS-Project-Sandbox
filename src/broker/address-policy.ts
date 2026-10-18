import { isIPv4, isIPv6 } from 'node:net';

// Which addresses the egress broker may connect to (prompt Stage 5 section 4.7). The broker
// resolves names on the host, and EVERY address a name resolves to must be public: a name that
// maps to a mix of public and internal addresses is a DNS-rebinding attempt and is refused whole.

export interface Cidr4 {
  readonly base: number;
  readonly bits: number;
}

function ip4ToInt(ip: string): number | null {
  if (!isIPv4(ip)) return null;
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] ?? 0) * 2 ** 24 + (p[1] ?? 0) * 2 ** 16 + (p[2] ?? 0) * 2 ** 8 + (p[3] ?? 0)) >>> 0;
}

function cidr4(text: string): Cidr4 {
  const [ip, bits] = text.split('/');
  const base = ip4ToInt(ip ?? '');
  if (base === null || bits === undefined) throw new TypeError(`bad CIDR ${text}`);
  return { base, bits: Number(bits) };
}

function inCidr4(n: number, c: Cidr4): boolean {
  if (c.bits === 0) return true;
  const shift = 32 - c.bits;
  return n >>> shift === c.base >>> shift;
}

/** Refused IPv4 ranges: unspecified, private, CGNAT, loopback, link-local, test nets, multicast, reserved. */
const BLOCKED_V4: readonly Cidr4[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map(cidr4);

/** Parses an IPv6 text address into 8 16-bit groups, or null. Zone ids are refused. */
export function parseIPv6(text: string): number[] | null {
  if (!isIPv6(text) || text.includes('%')) return null;
  let s = text;
  const groups: number[] = [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ip4ToInt(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const rest = parse(halves[1] ?? '');
  if (rest === null || head.length + rest.length > 7) return null;
  groups.push(...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest);
  return groups;
}

function v4FromGroups(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function blockedV6(g: readonly number[]): string | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, hi = 0, lo = 0] = g;
  const allZeroTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (allZeroTo(8)) return 'unspecified address';
  if (allZeroTo(7) && lo === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d)
  if (allZeroTo(5) && (f === 0xffff || f === 0)) {
    return blockedV4(v4FromGroups(hi, lo)) ? 'embedded IPv4 address in a blocked range' : null;
  }
  // NAT64 64:ff9b::/96 embeds an IPv4 address in the last 32 bits
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return blockedV4(v4FromGroups(hi, lo)) ? 'NAT64 form of a blocked IPv4 address' : null;
  }
  // 6to4 2002::/16 embeds the IPv4 address in groups 1 and 2
  if (a === 0x2002) {
    return blockedV4(v4FromGroups(b, c)) ? '6to4 form of a blocked IPv4 address' : null;
  }
  if (a === 0x2001 && b === 0) return 'Teredo';
  if (a === 0x2001 && b === 0xdb8) return 'documentation range';
  if ((a & 0xfe00) === 0xfc00) return 'unique local address';
  if ((a & 0xffc0) === 0xfe80) return 'link-local address';
  if ((a & 0xff00) === 0xff00) return 'multicast';
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return 'discard prefix';
  return null;
}

function blockedV4(n: number, extra: readonly Cidr4[] = []): boolean {
  return BLOCKED_V4.some((c) => inCidr4(n, c)) || extra.some((c) => inCidr4(n, c));
}

export interface AddressVerdict {
  readonly public: boolean;
  readonly reason?: string;
}

/**
 * Whether the broker may connect to `ip`. `hostRanges` are the machine's own networks (for WSL2
 * the NAT gateway, which is the Windows host), read from the routing table by the caller.
 */
export function classifyAddress(ip: string, hostRanges: readonly Cidr4[] = []): AddressVerdict {
  const v4 = ip4ToInt(ip);
  if (v4 !== null) {
    if (BLOCKED_V4.some((c) => inCidr4(v4, c)))
      return { public: false, reason: 'private or reserved IPv4' };
    if (hostRanges.some((c) => inCidr4(v4, c)))
      return { public: false, reason: "this machine's own network" };
    return { public: true };
  }
  const g = parseIPv6(ip);
  if (g === null) return { public: false, reason: 'not an IP address' };
  const why = blockedV6(g);
  if (why !== null) return { public: false, reason: why };
  // An IPv4 address hidden in an IPv6 form is also checked against the host's own networks.
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, hi = 0, lo = 0] = g;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    if (hostRanges.some((r) => inCidr4(v4FromGroups(hi, lo), r))) {
      return { public: false, reason: "this machine's own network" };
    }
  }
  return { public: true };
}

/** All of `ips` must be public; an empty list is refused. */
export function allPublic(
  ips: readonly string[],
  hostRanges: readonly Cidr4[] = [],
): AddressVerdict {
  if (ips.length === 0) return { public: false, reason: 'no addresses' };
  for (const ip of ips) {
    const v = classifyAddress(ip, hostRanges);
    if (!v.public) return v;
  }
  return { public: true };
}

/**
 * The networks this machine is directly attached to and its default gateway, from the text of
 * /proc/net/route. WSL2 NAT puts the Windows host at the gateway, so it is refused as a target.
 */
export function hostRangesFromRoutes(routeText: string): Cidr4[] {
  const out: Cidr4[] = [];
  const hexIp = (h: string): number | null => {
    if (!/^[0-9A-Fa-f]{8}$/.test(h)) return null;
    const n = parseInt(h, 16);
    // /proc/net/route stores addresses in host (little-endian) byte order
    return (
      (((n & 0xff) << 24) |
        (((n >>> 8) & 0xff) << 16) |
        (((n >>> 16) & 0xff) << 8) |
        ((n >>> 24) & 0xff)) >>>
      0
    );
  };
  for (const line of routeText.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const dest = hexIp(f[1] ?? '');
    const gw = hexIp(f[2] ?? '');
    const mask = hexIp(f[7] ?? '');
    if (dest === null || gw === null || mask === null) continue;
    if (dest === 0 && mask === 0) {
      if (gw !== 0) out.push({ base: gw, bits: 32 }); // default route: the gateway itself
    } else {
      let bits = 0;
      for (let m = mask; (m & 0x80000000) !== 0; m = (m << 1) >>> 0) bits++;
      out.push({ base: dest, bits });
    }
  }
  return out;
}
