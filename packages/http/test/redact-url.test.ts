import 'mocha';
import { expect } from 'chai';
import { EventEmitter } from 'node:events';

import { redactUrl, urlPath } from '../src/util/redact-url.js';
import { AccessLog } from '../src/middlewares/AccessLog.js';
import { SlowRequestWarning } from '../src/middlewares/SlowRequestWarning.js';

const SECRET = 'Zq7urlSecretKp3';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

describe('redactUrl', () => {
  for (const [url, expected] of [
    ['/a/b', '/a/b'],
    ['/a/b?', '/a/b'],
    ['/a/b?token=x&page=2', '/a/b?token=[redacted]&page=[redacted]'],
    ['/a?id=1&id=2', '/a?id=[redacted]&id=[redacted]'],
    ['/a?a=', '/a?[redacted]'],
    ['/a?a==', '/a?[redacted]'],
    ['/a?=x', '/a?[redacted]'],
    [`/reset?${SECRET}`, '/reset?[redacted]'],
    ['/reset?dGhpc2lzYXNlY3JldHRva2Vu==', '/reset?[redacted]'],
    [`/reset?${SECRET}=`, '/reset?[redacted]'],
    [`/reset?page=1&${SECRET}=`, '/reset?page=[redacted]&[redacted]'],
    [`/v?${JWT}==`, '/v?[redacted]'],
    [`/v?${JWT}=1`, '/v?[redacted]'],
    ['/a?%E0%A4%A=1', '/a?[redacted]'],
    ['/a?ok=1&%E0%A4%A', '/a?ok=[redacted]&[redacted]'],
    ['/a?a+b=1', '/a?[redacted]'],
    ['/a?q=a+b', '/a?q=[redacted]'],
    ['/a?filter%5Bname%5D=x&sort.by=y&x-y=z', '/a?filter[name]=[redacted]&sort.by=[redacted]&x-y=[redacted]'],
    [`/a?${'k'.repeat(32)}=1`, `/a?${'k'.repeat(32)}=[redacted]`],
    [`/a?${'k'.repeat(33)}=1`, '/a?[redacted]'],
    ['/a?a=1&&b=2', '/a?a=[redacted]&b=[redacted]'],
    ['/a?x=1=2', '/a?x=[redacted]'],
    [`/a?${encodeURIComponent('<script>')}=1`, '/a?[redacted]'],
  ]) {
    it(`${url} -> ${expected}`, () => {
      expect(redactUrl(url)).to.eq(expected);
    });
  }

  it('never throws on malformed percent-encoding', () => {
    expect(() => redactUrl('/a?%=%&%zz=%E0%A4%A&%')).to.not.throw();
    expect(redactUrl('/a?%=%&%zz=%E0%A4%A&%')).to.eq('/a?[redacted]&[redacted]&[redacted]');
  });

  it('keeps the path as it is', () => {
    expect(redactUrl('/api/v1/users/42?x=1')).to.eq('/api/v1/users/42?x=[redacted]');
  });

  it('urlPath drops the query', () => {
    expect(urlPath('/a/b?token=x')).to.eq('/a/b');
    expect(urlPath('/a/b')).to.eq('/a/b');
  });

  it('answers an empty string for a missing URL instead of throwing', () => {
    expect(redactUrl(undefined)).to.eq('');
    expect(urlPath(undefined)).to.eq('');
  });
});

describe('request log lines redact query values', () => {
  const url = `/secret-echo/account?token=${SECRET}&password=${SECRET}x&${SECRET}y`;

  function recordingLog() {
    const lines: unknown[][] = [];
    const record = (...args: unknown[]) => lines.push(args);
    return { lines, log: { info: record, warn: record, error: record, debug: record, trace: record } };
  }

  function fire(handler: (req: any, res: any, next: () => void) => void) {
    const req: any = { method: 'GET', originalUrl: url, headers: {}, storage: {} };
    const res: any = new EventEmitter();
    res.statusCode = 200;
    handler(req, res, () => undefined);
    res.emit('finish');
  }

  function expectRedacted(lines: unknown[][]) {
    expect(lines).to.have.length(1);
    const text = JSON.stringify(lines[0]);
    expect(text).to.not.include(SECRET);
    expect(text).to.include('token=[redacted]');
    expect(text).to.include('password=[redacted]');
  }

  // `@Config` and `@Logger` define getters without setters on the prototype.
  function override(target: object, values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(target, key, { value });
    }
  }

  it('AccessLog', () => {
    const mw = new AccessLog();
    const { lines, log } = recordingLog();
    override(mw, { Log: log, Enabled: true });

    fire(mw.before()!);

    expectRedacted(lines);
  });

  it('SlowRequestWarning', () => {
    const mw = new SlowRequestWarning();
    const { lines, log } = recordingLog();
    override(mw, { Log: log, Enabled: true, ThresholdMs: 0 });

    fire(mw.before()!);

    expectRedacted(lines);
  });
});
