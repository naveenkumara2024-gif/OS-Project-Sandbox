import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  INVALID_REQUEST,
  LineFramer,
  MAX_LINE_BYTES,
  parseMessage,
  PARSE_ERROR,
  resultMessage,
} from '../../src/gateway/mcp/jsonrpc.js';

describe('parseMessage', () => {
  it('classifies requests and notifications', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({
      kind: 'request',
      id: 1,
      method: 'ping',
      params: undefined,
    });
    expect(parseMessage('{"jsonrpc":"2.0","id":"a","method":"x","params":{"k":1}}')).toMatchObject({
      kind: 'request',
      id: 'a',
      params: { k: 1 },
    });
    expect(parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({
      kind: 'notification',
      method: 'notifications/initialized',
      params: undefined,
    });
  });

  it.each([
    ['not json', '{nope', PARSE_ERROR, null],
    [
      'an array (batches are unsupported)',
      '[{"jsonrpc":"2.0","id":1,"method":"ping"}]',
      INVALID_REQUEST,
      null,
    ],
    ['a bare number', '5', INVALID_REQUEST, null],
    ['wrong version', '{"jsonrpc":"1.0","id":3,"method":"ping"}', INVALID_REQUEST, 3],
    ['missing method', '{"jsonrpc":"2.0","id":4}', INVALID_REQUEST, 4],
    ['method not a string', '{"jsonrpc":"2.0","id":5,"method":7}', INVALID_REQUEST, 5],
    ['null id', '{"jsonrpc":"2.0","id":null,"method":"ping"}', INVALID_REQUEST, null],
    ['object id', '{"jsonrpc":"2.0","id":{},"method":"ping"}', INVALID_REQUEST, null],
    ['a response, not a request', '{"jsonrpc":"2.0","id":1,"result":{}}', INVALID_REQUEST, 1],
  ])('rejects %s', (_n, line, code, id) => {
    expect(parseMessage(line)).toMatchObject({ kind: 'invalid', code, id });
  });

  it('rejects prototype-polluting keys anywhere', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const line = `{"jsonrpc":"2.0","id":1,"method":"x","params":{"${key}":{"polluted":1}}}`;
      expect(parseMessage(line).kind, key).toBe('invalid');
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(['request', 'notification', 'invalid']).toContain(parseMessage(s).kind);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary JSON values', () => {
    fc.assert(
      fc.property(fc.json(), (j) => {
        expect(['request', 'notification', 'invalid']).toContain(parseMessage(j).kind);
      }),
      { numRuns: 500 },
    );
  });

  it('the messages it writes are single lines that parse back', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.integer()), fc.string(), (id, text) => {
        for (const line of [resultMessage(id, { text }), errorMessage(id, -32602, text)]) {
          expect(line).not.toMatch(/[\r\n]/);
          expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0', id });
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('LineFramer', () => {
  it('splits lines across chunks, tolerates CRLF, and skips empty lines', () => {
    const f = new LineFramer();
    const lines: string[] = [];
    for (const chunk of ['{"a":', '1}\r\n\n{"b"', ':2}\n']) {
      for (const e of f.push(Buffer.from(chunk))) if (e.kind === 'line') lines.push(e.text);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a multi-byte character split across chunks', () => {
    const f = new LineFramer();
    const bytes = Buffer.from('{"s":"€"}\n');
    const out = [...f.push(bytes.subarray(0, 7)), ...f.push(bytes.subarray(7))];
    expect(out).toEqual([{ kind: 'line', text: '{"s":"€"}' }]);
  });

  it('reports invalid UTF-8 once and carries on with the next line', () => {
    const f = new LineFramer();
    const out = f.push(Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"ok":1}\n')]));
    expect(out).toEqual([
      { kind: 'bad', reason: 'bad_utf8' },
      { kind: 'line', text: '{"ok":1}' },
    ]);
  });

  it('drops an over-long line up to its newline, reports it once, and recovers', () => {
    const f = new LineFramer();
    const out = [
      ...f.push(Buffer.alloc(MAX_LINE_BYTES, 0x61)),
      ...f.push(Buffer.alloc(10, 0x61)), // the line is now over the cap: discarding
      ...f.push(Buffer.alloc(1000, 0x61)),
      ...f.push(Buffer.from('tail\n{"after":1}\n')),
    ];
    expect(out.filter((e) => e.kind === 'bad')).toEqual([{ kind: 'bad', reason: 'too_long' }]);
    expect(out.filter((e) => e.kind === 'line')).toEqual([{ kind: 'line', text: '{"after":1}' }]);
  });

  it('a line of exactly the cap is accepted; one byte more is not', () => {
    const f = new LineFramer();
    const ok = f.push(Buffer.concat([Buffer.alloc(MAX_LINE_BYTES, 0x61), Buffer.from('\n')]));
    expect(ok.map((e) => e.kind)).toEqual(['line']);
    const f2 = new LineFramer();
    const bad = f2.push(Buffer.concat([Buffer.alloc(MAX_LINE_BYTES + 1, 0x61), Buffer.from('\n')]));
    expect(bad.map((e) => e.kind)).toEqual(['bad']);
  });

  it('property: any chunking of the same bytes yields the same lines', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ maxLength: 20 }).filter((s) => !s.includes('\n') && !s.includes('\r')),
          {
            maxLength: 8,
          },
        ),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 6 }),
        (parts, cuts) => {
          const data = Buffer.from(parts.map((p) => `${p}\n`).join(''));
          const expected = parts.filter((p) => p !== '');
          const f = new LineFramer();
          const got: string[] = [];
          let at = 0;
          let i = 0;
          while (at < data.length) {
            const n = cuts[i++ % cuts.length] ?? 1;
            for (const e of f.push(data.subarray(at, at + n)))
              if (e.kind === 'line') got.push(e.text);
            at += n;
          }
          expect(got).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
