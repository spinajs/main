import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { EmailVerificationStore } from '../src/contracts.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { DnsVerifier } from '../src/verifiers/dns.js';
import type { MxResolver } from '../src/verifiers/dns.js';
import { ListVerifier } from '../src/verifiers/list.js';
import { boot, shutdown } from './support.js';

type Answer = unknown[] | string | { reject: unknown };
let zone: Record<string, { mx?: Answer; a?: Answer; aaaa?: Answer }> = {};

const answer = (a: Answer) => {
  if (!Array.isArray(a) && typeof a === 'object') throw a.reject;
  if (typeof a === 'string') throw Object.assign(new Error(a), { code: a });
  return a;
};

const fake: MxResolver = {
  resolveMx: async (d) => answer(zone[d]?.mx ?? 'ENOTFOUND') as { exchange: string; priority: number }[],
  resolve4: async (d) => answer(zone[d]?.a ?? (zone[d] ? 'ENODATA' : 'ENOTFOUND')) as string[],
  resolve6: async (d) => answer(zone[d]?.aaaa ?? (zone[d] ? 'ENODATA' : 'ENOTFOUND')) as string[],
};

const proto = DnsVerifier.prototype as unknown as { createResolver: () => MxResolver };
const realCreateResolver = proto.createResolver;

const TYPES = [ListVerifier, EmailVerificationStore, MemoryEmailVerificationStore];
const verifier = () => boot(DnsVerifier, { lists: { sources: [] } }, TYPES);

describe('DnsVerifier', () => {
  before(() => (proto.createResolver = () => fake));
  after(() => (proto.createResolver = realCreateResolver));
  beforeEach(() => (zone = {}));
  afterEach(shutdown);

  const expectVerdict = async (domain: string, verdict: object, ttl: number) => {
    const v = await verifier();
    const got = await v.verify(domain);
    expect(got).to.deep.eq(verdict);
    expect(v.ttlFor(got)).to.eq(ttl);
  };

  it('refuses a domain that does not exist (NXDOMAIN)', () => expectVerdict('gone.com', { result: 'refuse', reason: 'domain_not_found' }, 3600));

  it('refuses a domain with no MX and no address', async () => {
    zone['bare.com'] = { mx: 'ENODATA' };
    await expectVerdict('bare.com', { result: 'refuse', reason: 'no_mail_host' }, 3600);
  });

  it('accepts an implicit MX (an A record and no MX)', async () => {
    zone['a-only.com'] = { mx: 'ENODATA', a: ['192.0.2.1'] };
    await expectVerdict('a-only.com', { result: 'unknown', reason: 'resolves' }, 86400);
  });

  it('accepts an empty MX answer with an AAAA record', async () => {
    zone['v6.com'] = { mx: [], aaaa: ['2001:db8::1'] };
    await expectVerdict('v6.com', { result: 'unknown', reason: 'resolves' }, 86400);
  });

  it('refuses a null MX (RFC 7505)', async () => {
    zone['nomail.com'] = { mx: [{ exchange: '', priority: 0 }] };
    await expectVerdict('nomail.com', { result: 'refuse', reason: 'null_mx' }, 86400);
  });

  it('refuses an MX host on the block-mx list', async () => {
    zone['fresh-trash.com'] = { mx: [{ exchange: 'mx1.MX.trash.io.', priority: 10 }] };
    const v = await verifier();
    await (await DI.resolve(MemoryEmailVerificationStore)).upsertEntries([{ domain: 'mx.trash.io', kind: 'block-mx', source: 'admin' }]);
    await (await DI.resolve(ListVerifier)).reload();
    const got = await v.verify('fresh-trash.com');
    expect(got).to.deep.eq({ result: 'refuse', reason: 'disposable_mx' });
    expect(v.ttlFor(got)).to.eq(3600);
  });

  it('refuses a null MX written as a dot', async () => {
    zone['dot.com'] = { mx: [{ exchange: '.', priority: 0 }] };
    await expectVerdict('dot.com', { result: 'refuse', reason: 'null_mx' }, 86400);
  });

  it('does not treat a null MX in a mixed list as null_mx', async () => {
    zone['mixed.com'] = {
      mx: [
        { exchange: '', priority: 0 },
        { exchange: 'mx.ok.com', priority: 10 },
      ],
    };
    await expectVerdict('mixed.com', { result: 'unknown', reason: 'resolves' }, 86400);
  });

  it('refuses a block-mx host that is not the first record', async () => {
    zone['multi.com'] = {
      mx: [
        { exchange: 'mx.ok.com', priority: 5 },
        { exchange: 'mx.trash.io', priority: 10 },
      ],
    };
    const v = await verifier();
    await (await DI.resolve(MemoryEmailVerificationStore)).upsertEntries([{ domain: 'trash.io', kind: 'block-mx', source: 'admin' }]);
    await (await DI.resolve(ListVerifier)).reload();
    expect(await v.verify('multi.com')).to.deep.eq({ result: 'refuse', reason: 'disposable_mx' });
  });

  it('answers an uncached unknown when AAAA fails after A has no data', async () => {
    zone['half.com'] = { mx: 'ENODATA', aaaa: 'ESERVFAIL' };
    await expectVerdict('half.com', { result: 'unknown' }, 0);
  });

  it('answers an uncached unknown when A contradicts an existing name', async () => {
    zone['flaky.com'] = { mx: 'ENODATA', a: 'ENOTFOUND' };
    await expectVerdict('flaky.com', { result: 'unknown' }, 0);
  });

  it('answers a cacheable unknown for a domain with MX records', async () => {
    zone['ok.com'] = { mx: [{ exchange: 'mx.ok.com', priority: 10 }] };
    await expectVerdict('ok.com', { result: 'unknown', reason: 'resolves' }, 86400);
  });

  it('answers an uncached unknown on SERVFAIL', async () => {
    zone['broken.com'] = { mx: 'ESERVFAIL' };
    await expectVerdict('broken.com', { result: 'unknown' }, 0);
  });

  it('answers an uncached unknown when the address lookup times out', async () => {
    zone['slow.com'] = { mx: 'ENODATA', a: 'ETIMEOUT' };
    await expectVerdict('slow.com', { result: 'unknown' }, 0);
  });

  it('answers an uncached unknown when the lookup rejects with a code-less Error', async () => {
    zone['odd.com'] = { mx: { reject: new TypeError('boom') } };
    await expectVerdict('odd.com', { result: 'unknown' }, 0);
  });

  for (const [name, reject] of [['a bare string', 'boom'], ['null', null], ['undefined', undefined]] as const) {
    it(`answers an uncached unknown when the lookup rejects with ${name}`, async () => {
      zone['odd.com'] = { mx: { reject } };
      await expectVerdict('odd.com', { result: 'unknown' }, 0);
    });
  }
});
