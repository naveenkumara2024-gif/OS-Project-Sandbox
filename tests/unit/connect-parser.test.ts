import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  headEnd,
  MAX_HEAD_BYTES,
  normaliseHost,
  parseConnect,
} from '../../src/broker/connect-parser.js';

const head = (line: string, headers: string[] = ['Host: x']) =>
  Buffer.from(`${line}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}\r\n`, 'latin1');

describe('parseConnect', () => {
  it('accepts a plain CONNECT and reports where the head ends', () => {
    const buf = Buffer.concat([
      head('CONNECT pypi.org:443 HTTP/1.1'),
      Buffer.from('\x16\x03\x01tls'),
    ]);
    const r = parseConnect(buf);
    expect(r).toEqual({ ok: true, host: 'pypi.org', port: 443, consumed: headEnd(buf) });
    expect(buf.subarray(headEnd(buf)).toString('latin1')).toBe('\x16\x03\x01tls');
  });

  it('normalises case and one trailing dot', () => {
    expect(parseConnect(head('CONNECT PyPI.ORG.:443 HTTP/1.0'))).toMatchObject({
      ok: true,
      host: 'pypi.org',
    });
  });

  it.each([
    ['another method', 'GET http://pypi.org/ HTTP/1.1', 'bad_method'],
    ['POST', 'POST / HTTP/1.1', 'bad_method'],
    ['lower-case method', 'connect pypi.org:443 HTTP/1.1', 'bad_method'],
    ['no port', 'CONNECT pypi.org HTTP/1.1', 'bad_request'],
    ['empty port', 'CONNECT pypi.org: HTTP/1.1', 'bad_request'],
    ['port zero', 'CONNECT pypi.org:0 HTTP/1.1', 'bad_request'],
    ['port too big', 'CONNECT pypi.org:65536 HTTP/1.1', 'bad_request'],
    ['leading-zero port', 'CONNECT pypi.org:0443 HTTP/1.1', 'bad_request'],
    ['signed port', 'CONNECT pypi.org:+443 HTTP/1.1', 'bad_request'],
    ['userinfo', 'CONNECT evil.com@pypi.org:443 HTTP/1.1', 'bad_request'],
    ['userinfo with colon', 'CONNECT pypi.org:443@evil.com:443 HTTP/1.1', 'bad_request'],
    ['bracketed IPv6', 'CONNECT [::1]:443 HTTP/1.1', 'bad_request'],
    ['IPv4', 'CONNECT 93.184.216.34:443 HTTP/1.1', 'bad_request'],
    ['short IPv4', 'CONNECT 127.1:443 HTTP/1.1', 'bad_request'],
    ['decimal IPv4', 'CONNECT 2130706433:443 HTTP/1.1', 'bad_request'],
    ['hex IPv4', 'CONNECT 0x7f.0.0.1:443 HTTP/1.1', 'bad_request'],
    ['octal-ish IPv4', 'CONNECT 0177.0.0.1:443 HTTP/1.1', 'bad_request'],
    ['hex single', 'CONNECT 0x7f000001:443 HTTP/1.1', 'bad_request'],
    ['percent escape', 'CONNECT pypi%2eorg:443 HTTP/1.1', 'bad_request'],
    ['a path', 'CONNECT pypi.org:443/x HTTP/1.1', 'bad_request'],
    ['a query', 'CONNECT pypi.org:443?x HTTP/1.1', 'bad_request'],
    ['underscore', 'CONNECT a_b.org:443 HTTP/1.1', 'bad_request'],
    ['leading hyphen', 'CONNECT -a.org:443 HTTP/1.1', 'bad_request'],
    ['empty label', 'CONNECT a..org:443 HTTP/1.1', 'bad_request'],
    ['two trailing dots', 'CONNECT a.org..:443 HTTP/1.1', 'bad_request'],
    ['space in the host', 'CONNECT a b.org:443 HTTP/1.1', 'bad_request'],
    ['HTTP/2 request line', 'CONNECT pypi.org:443 HTTP/2', 'bad_request'],
    ['no version', 'CONNECT pypi.org:443', 'bad_request'],
    ['two spaces', 'CONNECT  pypi.org:443 HTTP/1.1', 'bad_request'],
  ])('refuses %s', (_name, line, reason) => {
    expect(parseConnect(head(line))).toEqual({ ok: false, reason });
  });

  it('refuses smuggling and malformed headers', () => {
    const req = 'CONNECT pypi.org:443 HTTP/1.1';
    for (const bad of [
      ['Content-Length: 10'],
      ['Transfer-Encoding: chunked'],
      ['transfer-encoding: chunked'],
      ['Host: x', ' folded: continuation'],
      ['Host x'],
      ['Host: x\u0000y'],
      ['Host: café'],
      ['Bad Name: x'],
      [': empty-name'],
    ]) {
      expect(parseConnect(head(req, bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseConnect(head(req, ['Content-Length: 0'])).ok).toBe(true);
  });

  it('refuses bare CR or LF, NUL, 8-bit text, an overlong line and an oversize head', () => {
    expect(parseConnect(Buffer.from('CONNECT pypi.org:443 HTTP/1.1\nHost: x\n\n')).ok).toBe(false);
    expect(parseConnect(Buffer.from('CONNECT pypi.org:443 HTTP/1.1\r\nHost: x\r\r\n\r\n')).ok).toBe(
      false,
    );
    expect(
      parseConnect(Buffer.from('CONNECT pypi.org:443\u0000 HTTP/1.1\r\n\r\n', 'latin1')).ok,
    ).toBe(false);
    expect(
      parseConnect(Buffer.from('CONNECT pypi.org:443 HTTP/1.1\r\nX: é\r\n\r\n', 'latin1')).ok,
    ).toBe(false);
    expect(parseConnect(head(`CONNECT ${'a'.repeat(600)}.org:443 HTTP/1.1`)).ok).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => `X-H${String(i)}: v`);
    expect(parseConnect(head('CONNECT pypi.org:443 HTTP/1.1', many)).ok).toBe(false);
    expect(
      parseConnect(head('CONNECT pypi.org:443 HTTP/1.1', [`X: ${'a'.repeat(MAX_HEAD_BYTES)}`])).ok,
    ).toBe(false);
  });

  it('an incomplete head is not a request', () => {
    expect(parseConnect(Buffer.from('CONNECT pypi.org:443 HTTP/1.1\r\nHost: x\r\n')).ok).toBe(
      false,
    );
    expect(headEnd(Buffer.from('abc'))).toBe(-1);
  });

  it('property: never throws, and an accepted host is always a clean name', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        const r = parseConnect(Buffer.from(bytes));
        if (r.ok) expect(r.host).toMatch(/^[a-z0-9.-]+$/);
      }),
      { numRuns: 800 },
    );
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.integer({ min: 0, max: 99999 }),
        (host, port) => {
          const r = parseConnect(head(`CONNECT ${host}:${String(port)} HTTP/1.1`));
          if (r.ok) {
            expect(r.port).toBeGreaterThanOrEqual(1);
            expect(r.port).toBeLessThanOrEqual(65535);
            expect(normaliseHost(r.host)).toBe(r.host);
          }
        },
      ),
      { numRuns: 800 },
    );
  });
});

describe('normaliseHost', () => {
  it('accepts names and refuses every address spelling', () => {
    expect(normaliseHost('Example.COM.')).toBe('example.com');
    expect(normaliseHost('files.pythonhosted.org')).toBe('files.pythonhosted.org');
    expect(normaliseHost('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const bad of [
      '',
      '.',
      'a..b',
      '1.2.3.4',
      '::1',
      'localhost.',
      '1.2.3',
      '0x10',
      '4294967296',
      'ex ample.com',
      'ex_ample.com',
      'пример.рф',
    ]) {
      if (bad === 'localhost.') {
        expect(normaliseHost(bad)).toBe('localhost'); // a name; the allowlist and address policy decide
      } else {
        expect(normaliseHost(bad), bad).toBeNull();
      }
    }
  });
});
