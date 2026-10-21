import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, Injectable } from '@spinajs/di';
import { DomainVerifier, EmailVerificationStore, UNKNOWN } from '../src/contracts.js';
import type { DomainVerdict } from '../src/contracts.js';
import { EmailVerification } from '../src/service.js';
import { MemoryEmailVerificationStore } from '../src/stores/memory.js';
import { boot, shutdown } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const calls: string[] = [];
let answers: Record<string, DomainVerdict | Error | 'hang'> = {};

abstract class StubVerifier extends DomainVerifier {
  public readonly cacheable: boolean = true;

  public async verify(domain: string): Promise<DomainVerdict> {
    calls.push(`${this.name}:${domain}`);
    const answer = answers[this.name] ?? UNKNOWN;
    if (answer === 'hang') return new Promise<DomainVerdict>(() => undefined);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  public ttlFor(): number {
    return 60;
  }
}

@Injectable(DomainVerifier)
class FirstStub extends StubVerifier {
  public readonly name = 'first';
}

@Injectable(DomainVerifier)
class SecondStub extends StubVerifier {
  public readonly name = 'second';
}

@Injectable(DomainVerifier)
class UncachedStub extends StubVerifier {
  public readonly name = 'uncached';
  public readonly cacheable = false;
}

const TYPES = [EmailVerificationStore, MemoryEmailVerificationStore, DomainVerifier, FirstStub, SecondStub, UncachedStub];
const service = (options: Record<string, unknown> = {}) => boot(EmailVerification, { verifiers: [{ service: 'FirstStub' }, { service: 'SecondStub' }], ...options }, TYPES);
const store = () => DI.resolve(MemoryEmailVerificationStore);

describe('EmailVerification', () => {
  beforeEach(() => {
    calls.length = 0;
    answers = {};
  });
  afterEach(shutdown);

  it('allows everything without calling a verifier when disabled', async () => {
    const result = await (await service({ enabled: false })).check('a@x.com');
    expect(result.allowed).to.eq(true);
    expect(calls).to.deep.eq([]);
  });

  it('refuses an address without a usable domain', async () => {
    const result = await (await service()).check('nobody');
    expect(result).to.deep.eq({ allowed: false, code: 'email_domain_refused', domain: null, source: 'address', reason: 'invalid_domain' });
  });

  it('runs verifiers in config order and stops at the first refusal', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    const result = await (await service()).check('a@X.com');
    expect(result).to.deep.eq({ allowed: false, code: 'email_domain_refused', domain: 'x.com', source: 'first', reason: 'listed' });
    expect(calls).to.deep.eq(['first:x.com']);
  });

  it('stops at an allow', async () => {
    answers.first = { result: 'allow' };
    const result = await (await service()).check('a@x.com');
    expect(result).to.deep.eq({ allowed: true, domain: 'x.com', source: 'first' });
    expect(calls).to.deep.eq(['first:x.com']);
  });

  it('takes the source from the verdict when it has one', async () => {
    answers.second = { result: 'refuse', reason: 'listed', source: 'list:admin' };
    const result = await (await service()).check('a@x.com');
    expect(result).to.include({ allowed: false, source: 'list:admin' });
  });

  it('allows when every verifier answers unknown', async () => {
    const result = await (await service()).check('a@x.com');
    expect(result).to.deep.eq({ allowed: true, domain: 'x.com' });
    expect(calls).to.deep.eq(['first:x.com', 'second:x.com']);
  });

  it('treats a throwing verifier as unknown', async () => {
    answers.first = new Error('boom');
    expect((await (await service()).check('a@x.com')).allowed).to.eq(true);
    expect(calls).to.deep.eq(['first:x.com', 'second:x.com']);
  });

  it('refuses on a throwing verifier under onError refuse', async () => {
    answers.first = new Error('boom');
    const result = await (await service({ onError: 'refuse' })).check('a@x.com');
    expect(result).to.include({ allowed: false, source: 'first', reason: 'verifier_error' });
  });

  it('treats a verifier over timeoutMs as unknown', async () => {
    answers.first = 'hang';
    const result = await (await service({ timeoutMs: 50 })).check('a@x.com');
    expect(result.allowed).to.eq(true);
    expect(calls).to.deep.eq(['first:x.com', 'second:x.com']);
  });

  it('serves a cached verdict without calling the verifier again', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    const s = await service();
    await s.check('a@x.com');
    await s.check('b@x.com');
    expect(calls).to.deep.eq(['first:x.com']);
  });

  it('reads a verdict from the store when the LRU misses', async () => {
    const s = await service();
    await (await store()).setVerdict('first', 'x.com', { result: 'refuse', reason: 'stored', checkedAt: Date.now() }, 60);
    expect(await s.check('a@x.com')).to.include({ allowed: false, reason: 'stored' });
    expect(calls).to.deep.eq([]);
  });

  it('writes a verdict to the store', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    await (await service()).check('a@x.com');
    expect(await (await store()).getVerdict('first', 'x.com')).to.include({ result: 'refuse', reason: 'listed' });
  });

  it('never caches a verifier that is not cacheable', async () => {
    const s = await service({ verifiers: [{ service: 'UncachedStub' }] });
    await s.check('a@x.com');
    await s.check('a@x.com');
    expect(calls).to.deep.eq(['uncached:x.com', 'uncached:x.com']);
  });

  it('runs one verifier call for concurrent checks of one domain', async () => {
    const s = await service({ verifiers: [{ service: 'UncachedStub' }] });
    await Promise.all([s.check('a@x.com'), s.check('b@X.com')]);
    expect(calls).to.deep.eq(['uncached:x.com']);
  });

  it('explains every verifier answer without the cache', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    answers.second = new Error('boom');
    const s = await service();
    await s.check('a@x.com');
    const explained = await s.explain('a@x.com');
    expect(calls.filter((c) => c === 'first:x.com')).to.have.length(2);
    expect(explained.domain).to.eq('x.com');
    expect(explained.outcomes).to.deep.eq([
      { verifier: 'first', verdict: { result: 'refuse', reason: 'listed' } },
      { verifier: 'second', verdict: UNKNOWN, error: 'boom' },
    ]);
  });

  it('falls back to the verifier when the store read hangs', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    const s = await service({ timeoutMs: 50 });
    (await store()).getVerdict = () => new Promise(() => undefined);
    expect(await s.check('a@x.com')).to.include({ allowed: false, reason: 'listed' });
    expect(calls).to.deep.eq(['first:x.com']);
  });

  it('completes when the store write hangs', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    const s = await service({ timeoutMs: 50 });
    (await store()).setVerdict = () => new Promise(() => undefined);
    expect(await s.check('a@x.com')).to.include({ allowed: false, reason: 'listed' });
  });

  it('falls back to the verifier when the store read throws', async () => {
    answers.first = { result: 'refuse', reason: 'listed' };
    const s = await service();
    (await store()).getVerdict = () => Promise.reject(new Error('store down'));
    expect(await s.check('a@x.com')).to.include({ allowed: false, reason: 'listed' });
    expect(calls).to.deep.eq(['first:x.com']);
  });

  it('fails the boot when a configured verifier is not registered', async () => {
    await expect(service({ verifiers: [{ service: 'NoSuchVerifier' }] })).to.be.rejected;
  });
});
