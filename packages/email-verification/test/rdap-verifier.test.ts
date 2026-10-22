import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { SafeFetch } from '../src/safe-fetch.js';
import { RdapVerifier, parseRdapBootstrap, rdapCandidates, registrationTime } from '../src/verifiers/rdap.js';
import { boot, json, shutdown, stubFetch, text } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP = { services: [[['com'], ['https://rdap.example/com/v1/']], [['uk'], ['http://insecure.example/', 'https://rdap.example/uk']]] };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const registered = (days: number) => json(200, { events: [{ eventAction: 'registration', eventDate: daysAgo(days) }] });

const verifier = (rdap: Record<string, unknown> = {}) => boot(RdapVerifier, { rdap }, [SafeFetch]);

describe('rdap helpers', () => {
  it('lists candidates from the full domain up, stopping before the TLD', () => {
    expect(rdapCandidates('a.b.foo.co.uk', 4)).to.deep.eq(['a.b.foo.co.uk', 'b.foo.co.uk', 'foo.co.uk', 'co.uk']);
    expect(rdapCandidates('a.b.foo.co.uk', 2)).to.deep.eq(['a.b.foo.co.uk', 'b.foo.co.uk']);
    expect(rdapCandidates('foo.com', 4)).to.deep.eq(['foo.com']);
  });

  it('maps each TLD to its first https server, with a trailing slash', () => {
    const servers = parseRdapBootstrap(JSON.stringify(BOOTSTRAP));
    expect(servers.get('com')).to.eq('https://rdap.example/com/v1/');
    expect(servers.get('uk')).to.eq('https://rdap.example/uk/');
  });

  it('refuses a bootstrap that is not JSON without quoting it', () => {
    expect(() => parseRdapBootstrap('<html>secret')).to.throw('invalid RDAP bootstrap').that.satisfies((e: Error) => !e.message.includes('secret') && !JSON.stringify(e).includes('secret'));
  });

  it('reads the registration event', () => {
    expect(registrationTime(JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2020-01-02T00:00:00Z' }] }))).to.eq(Date.parse('2020-01-02T00:00:00Z'));
    expect(registrationTime('{"events":[]}')).to.eq(null);
    expect(registrationTime('not json')).to.eq(null);
  });

  it('uses the earliest registration event', () => {
    const body = JSON.stringify({
      events: [
        { eventAction: 'registration', eventDate: '2024-05-01T00:00:00Z' },
        { eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' },
        { eventAction: 'last changed', eventDate: '2001-01-01T00:00:00Z' },
      ],
    });
    expect(registrationTime(body)).to.eq(Date.parse('2010-01-01T00:00:00Z'));
  });

  it('treats a future registration date as unknown', () => {
    const body = JSON.stringify({ events: [{ eventAction: 'registration', eventDate: '2030-01-01T00:00:00Z' }] });
    expect(registrationTime(body, Date.parse('2026-01-01T00:00:00Z'))).to.eq(null);
  });
});

describe('RdapVerifier', () => {
  let stub: ReturnType<typeof stubFetch> | undefined;
  afterEach(async () => {
    stub?.restore();
    await shutdown();
  });

  const serve = (routes: Record<string, () => Response>) =>
    (stub = stubFetch((url) => (url === BOOTSTRAP_URL ? json(200, BOOTSTRAP) : (routes[url]?.() ?? text(404, '')))));

  it('refuses a domain registered fewer than minAgeDays ago', async () => {
    serve({ 'https://rdap.example/com/v1/domain/new.com': () => registered(2) });
    const v = await verifier();
    const got = await v.verify('new.com');
    expect(got).to.deep.eq({ result: 'refuse', reason: 'domain_too_new' });
    expect(v.ttlFor(got)).to.eq(3600);
  });

  it('answers a long-cached unknown for an old domain', async () => {
    serve({ 'https://rdap.example/com/v1/domain/old.com': () => registered(400) });
    const v = await verifier();
    const got = await v.verify('old.com');
    expect(got).to.deep.eq({ result: 'unknown', reason: 'registered' });
    expect(v.ttlFor(got)).to.eq(2592000);
  });

  it('walks up past 404s', async () => {
    serve({ 'https://rdap.example/com/v1/domain/old.com': () => registered(400) });
    expect((await (await verifier()).verify('mail.old.com')).reason).to.eq('registered');
    expect(stub!.calls.map((c) => c.url)).to.deep.eq([BOOTSTRAP_URL, 'https://rdap.example/com/v1/domain/mail.old.com', 'https://rdap.example/com/v1/domain/old.com']);
  });

  it('never refuses on 404', async () => {
    serve({});
    const v = await verifier();
    const got = await v.verify('nowhere.com');
    expect(got).to.deep.eq({ result: 'unknown' });
    expect(v.ttlFor(got)).to.eq(0);
  });

  it('caches a rate limit for rateLimitedTtlSeconds', async () => {
    serve({ 'https://rdap.example/com/v1/domain/busy.com': () => text(429, '') });
    const v = await verifier();
    const got = await v.verify('busy.com');
    expect(got).to.deep.eq({ result: 'unknown', reason: 'rate_limited' });
    expect(v.ttlFor(got)).to.eq(3600);
  });

  it('answers unknown when no server covers the TLD', async () => {
    serve({});
    expect(await (await verifier()).verify('x.zz')).to.deep.eq({ result: 'unknown' });
    expect(stub!.calls).to.have.length(1);
  });

  it('stops after maxLookups requests', async () => {
    serve({});
    await (await verifier({ maxLookups: 2 })).verify('a.b.c.foo.com');
    expect(stub!.calls).to.have.length(3);
  });

  it('loads the bootstrap once', async () => {
    serve({});
    const v = await verifier();
    await v.verify('one.com');
    await v.verify('two.com');
    expect(stub!.calls.filter((c) => c.url === BOOTSTRAP_URL)).to.have.length(1);
  });

  const bootstrapCalls = () => stub!.calls.filter((c) => c.url === BOOTSTRAP_URL).length;
  const expireBootstrap = (v: RdapVerifier) => ((v as unknown as { Bootstrap: { loadedAt: number } }).Bootstrap.loadedAt = 0);

  it('keeps the last bootstrap when a refresh fails', async () => {
    serve({ 'https://rdap.example/com/v1/domain/old.com': () => registered(400) });
    const v = await verifier();
    await v.verify('old.com');
    expireBootstrap(v);
    stub!.restore();
    stub = stubFetch((url) => (url === BOOTSTRAP_URL ? text(500, '') : registered(400)));
    expect((await v.verify('old.com')).reason).to.eq('registered');
    expect(bootstrapCalls()).to.eq(1);
  });

  it('does not retry a failed refresh within the backoff', async () => {
    serve({ 'https://rdap.example/com/v1/domain/old.com': () => registered(400) });
    const v = await verifier();
    await v.verify('old.com');
    expireBootstrap(v);
    stub!.restore();
    stub = stubFetch((url) => (url === BOOTSTRAP_URL ? text(500, '') : registered(400)));
    await v.verify('old.com');
    await v.verify('old.com');
    expect(bootstrapCalls()).to.eq(1);
  });

  it('throws when the first bootstrap load fails', async () => {
    stub = stubFetch(() => text(500, ''));
    await expect((await verifier()).verify('x.com')).to.be.rejected;
  });

  it('does not retry a failed first load within the backoff', async () => {
    stub = stubFetch(() => text(500, ''));
    const v = await verifier();
    await expect(v.verify('x.com')).to.be.rejected;
    await expect(v.verify('x.com')).to.be.rejectedWith('RDAP bootstrap unavailable');
    expect(bootstrapCalls()).to.eq(1);
  });

  it('shares one bootstrap request between concurrent verifies', async () => {
    serve({});
    const v = await verifier();
    await Promise.all([v.verify('one.com'), v.verify('two.com')]);
    expect(bootstrapCalls()).to.eq(1);
  });

  it('does not replace a good bootstrap with an empty one', async () => {
    serve({ 'https://rdap.example/com/v1/domain/old.com': () => registered(400) });
    const v = await verifier();
    await v.verify('old.com');
    expireBootstrap(v);
    stub!.restore();
    stub = stubFetch((url) => (url === BOOTSTRAP_URL ? json(200, { services: [] }) : registered(400)));
    expect((await v.verify('old.com')).reason).to.eq('registered');
  });

  it('prefers the earliest registration event over the first one', async () => {
    serve({
      'https://rdap.example/com/v1/domain/old.com': () =>
        json(200, {
          events: [
            { eventAction: 'registration', eventDate: daysAgo(1) },
            { eventAction: 'registration', eventDate: daysAgo(400) },
          ],
        }),
    });
    expect((await (await verifier()).verify('old.com')).reason).to.eq('registered');
  });

  it('answers unknown for a future registration date', async () => {
    serve({ 'https://rdap.example/com/v1/domain/odd.com': () => registered(-5) });
    expect(await (await verifier()).verify('odd.com')).to.deep.eq({ result: 'unknown' });
  });
});
