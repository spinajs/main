import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Configuration } from '@spinajs/configuration';
import { boot, shutdown } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const config = (options: Record<string, unknown>) => boot(Configuration, options);

describe('emailVerification schema', () => {
  afterEach(shutdown);

  it('fills every default', async () => {
    const cfg = await config({});
    expect(cfg.get('emailVerification.store')).to.eq('MemoryEmailVerificationStore');
    expect(cfg.get('emailVerification.verifiers')).to.deep.eq([{ service: 'ListVerifier' }, { service: 'DnsVerifier' }]);
    expect(cfg.get('emailVerification.onError')).to.eq('allow');
    expect(cfg.get('emailVerification.refuseCode')).to.eq('email_domain_refused');
    expect(cfg.get('emailVerification.dns.ttl.negative')).to.eq(3600);
    expect(cfg.get('emailVerification.rdap.ttl.positive')).to.eq(2592000);
    expect(cfg.get('emailVerification.lists.sources')).to.have.length(1);
    expect(cfg.get('emailVerification.orm.connection')).to.eq('email-verification-connection');
  });

  it('fills defaults inside a list source', async () => {
    const cfg = await config({ lists: { sources: [{ name: 'mine', url: 'https://example.com/l.txt', kind: 'block' }] } });
    expect(cfg.get('emailVerification.lists.sources')).to.deep.eq([{ name: 'mine', url: 'https://example.com/l.txt', kind: 'block', format: 'lines' }]);
    expect(cfg.get('emailVerification.lists.refreshSeconds')).to.eq(30);
  });

  it('refuses an unknown onError', async () => {
    await expect(config({ onError: 'maybe' })).to.be.rejectedWith(/emailVerification\.onError must be equal to one of the allowed values/);
  });

  it('refuses a list source over http', async () => {
    await expect(config({ lists: { sources: [{ name: 'x', url: 'http://example.com/l', kind: 'block' }] } })).to.be.rejectedWith(/emailVerification\.lists\.sources\.0\.url must match pattern/);
  });

  it('refuses a list source named admin', async () => {
    await expect(config({ lists: { sources: [{ name: 'admin', url: 'https://example.com/l', kind: 'block' }] } })).to.be.rejectedWith(/emailVerification\.lists\.sources\.0\.name must NOT be valid/);
  });

  it('refuses an http provider URL without {domain}', async () => {
    await expect(config({ http: { providers: [{ name: 'p', url: 'https://api.example/check', resultPath: 'x' }] } })).to.be.rejectedWith(/emailVerification\.http\.providers\.0\.url must match pattern/);
  });

  [
    ['an object', { a: 1 }],
    ['an array', [1]],
  ].forEach(([what, entry]) => {
    it(`refuses ${what as string} as a refuseWhen entry`, async () => {
      await expect(config({ http: { providers: [{ name: 'p', url: 'https://api.example/{domain}', resultPath: 'x', refuseWhen: ['true', entry] }] } })).to.be.rejectedWith(
        /emailVerification\.http\.providers\.0\.refuseWhen\.1 must NOT be valid/,
      );
    });
  });

  it('refuses an http provider header value with a control character', async () => {
    await expect(config({ http: { providers: [{ name: 'p', url: 'https://api.example/{domain}', resultPath: 'x', headers: { 'x-key': 'SECRET\nx' } }] } })).to.be.rejectedWith(
      /emailVerification\.http\.providers\.0\.headers\.x-key must match pattern/,
    );
  });

  it('refuses an http provider header name that is not a token', async () => {
    await expect(config({ http: { providers: [{ name: 'p', url: 'https://api.example/{domain}', resultPath: 'x', headers: { 'x key': 'v' } }] } })).to.be.rejectedWith(
      /emailVerification\.http\.providers\.0\.headers\.x key property name is invalid/,
    );
  });

  it('keeps the type of each refuseWhen value', async () => {
    const cfg = await config({ http: { providers: [{ name: 'p', url: 'https://api.example/{domain}', resultPath: 'x', refuseWhen: ['true', 1, false] }] } });
    expect(cfg.get('emailVerification.http.providers.0.refuseWhen')).to.deep.eq(['true', 1, false]);
  });
});
