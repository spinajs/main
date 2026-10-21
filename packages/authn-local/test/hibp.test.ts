import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';

import { HibpPasswordBlocklist } from '../src/hibp.js';
import { recordingLog } from './support/recording-log.js';

const URL_BASE = 'https://hibp.test/range/';
const PASSWORD = 'correct horse battery staple';
const HASH = createHash('sha1').update(PASSWORD, 'utf8').digest('hex').toUpperCase();
const PREFIX = HASH.slice(0, 5);
const SUFFIX = HASH.slice(5);
const OTHER_SUFFIXES = ['0018A45C4D1DEF81644B54AB7F969B88D65', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC', '011053FD0102E94D6AE2F8B83D76FAF94F6'];

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;

describe('HibpPasswordBlocklist', () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[];
  let lines: string[];

  function fakeFetch(answer: FakeFetch): void {
    calls = [];
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return answer(url, init ?? {});
    };
  }

  const rangeBody = (rows: string[]) => async () => new Response(rows.join('\r\n'), { status: 200, headers: { 'content-type': 'text/plain' } });

  function blocklist(timeoutMs = 2000): HibpPasswordBlocklist {
    lines = [];
    return new HibpPasswordBlocklist({ url: URL_BASE, timeoutMs, log: recordingLog(lines) });
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('requests the range of the first five hex characters of the upper-case SHA-1, and nothing more', async () => {
    fakeFetch(rangeBody([`${OTHER_SUFFIXES[0]}:3`]));
    await blocklist().isBlocked(PASSWORD);
    expect(calls).to.have.length(1);
    expect(calls[0].url).to.eq(`${URL_BASE}${PREFIX}`);
    expect(PREFIX).to.match(/^[0-9A-F]{5}$/);
    const sent = JSON.stringify(calls[0]);
    expect(sent).to.not.contain(SUFFIX);
    expect(sent).to.not.contain(PASSWORD);
    expect(calls[0].init.body ?? null).to.eq(null);
  });

  it('sends the Add-Padding: true header', async () => {
    fakeFetch(rangeBody([]));
    await blocklist().isBlocked(PASSWORD);
    expect(new Headers(calls[0].init.headers).get('Add-Padding')).to.eq('true');
  });

  it('blocks a password whose suffix the range lists', async () => {
    fakeFetch(rangeBody([`${OTHER_SUFFIXES[0]}:3`, `${SUFFIX}:42`, `${OTHER_SUFFIXES[1]}:1`]));
    expect(await blocklist().isBlocked(PASSWORD)).to.eq(true);
    expect(lines).to.deep.eq([]);
  });

  it('passes a password whose suffix the range does not list', async () => {
    fakeFetch(rangeBody(OTHER_SUFFIXES.map((s) => `${s}:7`)));
    expect(await blocklist().isBlocked(PASSWORD)).to.eq(false);
    expect(lines).to.deep.eq([]);
  });

  it('passes a suffix listed only as a padding row (count 0)', async () => {
    fakeFetch(rangeBody([`${OTHER_SUFFIXES[0]}:3`, `${SUFFIX}:0`]));
    expect(await blocklist().isBlocked(PASSWORD)).to.eq(false);
  });

  it('passes on a timeout and logs one warning', async () => {
    fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const started = Date.now();
    expect(await blocklist(30).isBlocked(PASSWORD)).to.eq(false);
    expect(Date.now() - started).to.be.lessThan(1500);
    expect(lines).to.have.length(1);
    expect(lines[0]).to.not.contain(PASSWORD);
    expect(lines[0]).to.not.contain(SUFFIX);
  });

  it('passes on a network error and logs one warning', async () => {
    fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await blocklist().isBlocked(PASSWORD)).to.eq(false);
    expect(lines).to.have.length(1);
    expect(lines[0]).to.not.contain(PASSWORD);
  });

  it('passes on an error answer and logs one warning', async () => {
    fakeFetch(async () => new Response('Service Unavailable', { status: 503 }));
    expect(await blocklist().isBlocked(PASSWORD)).to.eq(false);
    expect(lines).to.have.length(1);
  });
});
