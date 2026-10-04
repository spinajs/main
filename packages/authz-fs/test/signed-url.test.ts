import * as chai from 'chai';
import 'mocha';
import { DateTime } from 'luxon';

import { AccessDenied, AuthorizationModel, AuthzClock, FALSE, TRUE } from '@spinajs/authz';
import type { AuthzService, DecisionRequest, ModelCapabilities, ModelSummary, Principal, Vote } from '@spinajs/authz';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { fs } from '@spinajs/fs';

import { guardFs, parseFsAccessConfig } from '../src/index.js';
import type { FsGuardOptions } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { FakeAuthz } from './support/fake-authz.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

const NOW = new Date('2026-10-04T12:00:00.000Z');
const MINUTE = 60_000;
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * MINUTE);

type Call = [method: string, ...args: unknown[]];

/** A key-store provider with the signing methods asked for; records what they get. */
function signer(name: string, calls: Call[], methods: { signedUrl?: boolean; getSignedUrl?: boolean } = { signedUrl: true, getSignedUrl: true }): fs {
  const provider = Object.create(fs.prototype) as fs & Record<string, unknown>;
  Object.assign(provider, { Options: { name } });
  Object.defineProperty(provider, 'Name', { value: name });
  if (methods.signedUrl) provider.signedUrl = async (...args: unknown[]) => (calls.push(['signedUrl', ...args]), 'https://signed/url');
  if (methods.getSignedUrl) provider.getSignedUrl = async (...args: unknown[]) => (calls.push(['getSignedUrl', ...args]), 'https://signed/get');
  return provider;
}

const untilOf = (call: Call | undefined): number | undefined => {
  const opts = call?.[2] as { until?: DateTime } | undefined;
  return opts?.until?.toMillis();
};

const alice = userPrincipal('alice');

describe('authz-fs signed URLs (D9)', function () {
  this.timeout(20000);

  let child: IContainer;
  let warnings: string[];
  let undoLog: () => void;

  const guard = (raw: fs, entry: Record<string, unknown>, authz: FakeAuthz, extra: Partial<FsGuardOptions> = {}): fs =>
    guardFs(raw, 'uploads', {
      config: parseFsAccessConfig('uploads', entry),
      container: child,
      service: async () => authz,
      principal: () => alice,
      log: { warn: (m: string) => warnings.push(m) },
      now: () => NOW,
      ...extra,
    });

  before(() => {
    undoLog = installQuietLog();
  });

  after(() => {
    undoLog();
  });

  beforeEach(async () => {
    child = await configuredChild(undefined);
    warnings = [];
  });

  afterEach(async () => {
    await child.dispose();
  });

  it('checks fs:share on the normalised file with its row and signs that path', async () => {
    const calls: Call[] = [];
    const authz = new FakeAuthz();
    const g = guard(signer('uploads', calls), { mode: 'enforce' }, authz);

    expect(await g.signedUrl!('./docs//a.txt')).to.equal('https://signed/url');
    expect(authz.calls.map((c) => [c.kind, c.permission, c.resource, c.subject])).to.deep.equal([['assert', 'fs:share', 'file:uploads:docs/a.txt', { id: 'uploads:docs/a.txt', type: 'file', fs: 'uploads', path: 'docs/a.txt' }]]);
    expect(calls).to.deep.equal([['signedUrl', 'docs/a.txt']]);
  });

  it('enforce: a denial is AccessDenied and nothing is signed', async () => {
    const calls: Call[] = [];
    const g = guard(signer('uploads', calls), { mode: 'enforce' }, new FakeAuthz(() => false));
    let error: unknown;
    await g.signedUrl!('a.txt').catch((e: unknown) => (error = e));
    expect(error).to.be.instanceOf(AccessDenied);
    expect(calls).to.deep.equal([]);
  });

  it('enforce: a conditional fs:share is AccessDenied too (D13)', async () => {
    const calls: Call[] = [];
    const g = guard(signer('uploads', calls), { mode: 'enforce' }, new FakeAuthz(() => 'conditional'));
    let error: unknown;
    await g.signedUrl!('a.txt').catch((e: unknown) => (error = e));
    expect(error).to.be.instanceOf(AccessDenied);
    expect(calls).to.deep.equal([]);
  });

  describe('until = min(asked, now + signedUrl.maxTtlSeconds, decision.validUntil)', () => {
    type Term = 'asked' | 'ttl' | 'validUntil';
    const TERMS: readonly Term[] = ['asked', 'ttl', 'validUntil'];
    const subsets = [1, 2, 3, 4, 5, 6, 7].map((mask) => TERMS.filter((_, i) => mask & (1 << i)));

    for (const present of subsets) {
      for (const smallest of present) {
        it(`${present.join(' + ')}: ${smallest} is the minimum`, async () => {
          // The smallest term ends in 5 minutes, the others in 10 and 15.
          const minutes = new Map<Term, number>();
          let next = 10;
          for (const t of present) minutes.set(t, t === smallest ? 5 : (next += 5) - 5);
          const calls: Call[] = [];
          const authz = new FakeAuthz();
          if (minutes.has('validUntil')) authz.validUntil = () => at(minutes.get('validUntil')!);
          const entry = minutes.has('ttl') ? { mode: 'enforce', signedUrl: { maxTtlSeconds: minutes.get('ttl')! * 60 } } : { mode: 'enforce' };
          const g = guard(signer('uploads', calls), entry, authz);
          const asked = minutes.has('asked') ? { until: DateTime.fromJSDate(at(minutes.get('asked')!)), disposition: 'attachment' } : { disposition: 'attachment' };

          await g.signedUrl!('a.txt', asked);
          expect(untilOf(calls[0])).to.equal(at(5).getTime());
          expect((calls[0][2] as { disposition?: string }).disposition).to.equal('attachment');
        });
      }
    }

    it('no term: the caller options go to the provider unchanged', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls), { mode: 'enforce' }, new FakeAuthz());
      const opts = { disposition: 'inline' };
      await g.signedUrl!('a.txt', opts);
      expect(calls).to.deep.equal([['signedUrl', 'a.txt', { disposition: 'inline' }]]);
    });

    it('keeps the asked DateTime when it is the minimum and never changes the caller options', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls), { mode: 'enforce', signedUrl: { maxTtlSeconds: 3600 } }, new FakeAuthz());
      const until = DateTime.fromJSDate(at(5), { zone: 'Europe/Warsaw' });
      const opts = { until };
      await g.signedUrl!('a.txt', opts);
      expect((calls[0][2] as { until: DateTime }).until).to.equal(until);
      expect(opts).to.deep.equal({ until });

      const later = { until: DateTime.fromJSDate(at(120)) };
      await g.signedUrl!('a.txt', later);
      expect(untilOf(calls[1])).to.equal(at(60).getTime());
      expect(later.until.toMillis()).to.equal(at(120).getTime());
    });

    it('reads now from the now option, so a maxTtlSeconds counts from the authz clock', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls), { mode: 'enforce', signedUrl: { maxTtlSeconds: 90 } }, new FakeAuthz(), { now: () => at(30) });
      await g.signedUrl!('a.txt');
      expect(untilOf(calls[0])).to.equal(at(31.5).getTime());
    });

    it('audit: a denied fs:share warns, signs, and the TTL still narrows', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls), { mode: 'audit', signedUrl: { maxTtlSeconds: 60 } }, new FakeAuthz(() => false));
      await g.signedUrl!('a.txt', { until: DateTime.fromJSDate(at(60)) });
      expect(untilOf(calls[0])).to.equal(at(1).getTime());
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.match(/lacks fs:share on file:uploads:a\.txt/);
    });

    it('refuses an asked until that is not a valid luxon DateTime, before any check or signing', async () => {
      for (const until of [NOW, DateTime.invalid('broken'), '2026-10-04']) {
        const calls: Call[] = [];
        const authz = new FakeAuthz();
        const g = guard(signer('uploads', calls), { mode: 'enforce' }, authz);
        let error: unknown;
        await g.signedUrl!('a.txt', { until: until as DateTime }).catch((e: unknown) => (error = e));
        expect(error, String(until)).to.be.instanceOf(InvalidArgument);
        expect(calls).to.deep.equal([]);
        expect(authz.calls).to.deep.equal([]);
      }
    });
  });

  describe('getSignedUrl', () => {
    it('is served through the raw signedUrl when the provider has one', async () => {
      const calls: Call[] = [];
      const authz = new FakeAuthz();
      authz.validUntil = () => at(7);
      const g = guard(signer('uploads', calls), { mode: 'enforce', signedUrl: { maxTtlSeconds: 600 } }, authz);
      expect(await (g as unknown as { getSignedUrl(p: string, u?: DateTime): Promise<string> }).getSignedUrl('/docs/a.txt', DateTime.fromJSDate(at(60)))).to.equal('https://signed/url');
      expect(authz.keys()).to.deep.equal(['fs:share file:uploads:docs/a.txt']);
      expect(calls.map((c) => c[0])).to.deep.equal(['signedUrl']);
      expect(calls[0][1]).to.equal('docs/a.txt');
      expect(untilOf(calls[0])).to.equal(at(7).getTime());
    });

    it('without a term it asks signedUrl with no until', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls), { mode: 'enforce' }, new FakeAuthz());
      await (g as unknown as { getSignedUrl(p: string): Promise<string> }).getSignedUrl('a.txt');
      expect(calls).to.deep.equal([['signedUrl', 'a.txt', {}]]);
    });

    it('a provider with getSignedUrl only gets the narrowed until as its second argument', async () => {
      const calls: Call[] = [];
      const g = guard(signer('uploads', calls, { getSignedUrl: true }), { mode: 'enforce', signedUrl: { maxTtlSeconds: 120 } }, new FakeAuthz());
      await (g as unknown as { getSignedUrl(p: string, u?: DateTime): Promise<string> }).getSignedUrl('a.txt', DateTime.fromJSDate(at(60)));
      expect(calls.map((c) => [c[0], c[1]])).to.deep.equal([['getSignedUrl', 'a.txt']]);
      expect((calls[0][2] as DateTime).toMillis()).to.equal(at(2).getTime());
    });

    it('a provider without either method behaves as the raw one: there is nothing to call', async () => {
      const authz = new FakeAuthz();
      const g = guard(signer('uploads', [], {}), { mode: 'enforce' }, authz) as unknown as Record<string, unknown>;
      expect(g.signedUrl).to.equal(undefined);
      expect(g.getSignedUrl).to.equal(undefined);
      expect(() => (g.signedUrl as () => unknown)()).to.throw(TypeError);
      expect(authz.calls).to.deep.equal([]);
    });
  });
});

const FS_ALL = ['fs:read', 'fs:stat', 'fs:list', 'fs:write', 'fs:delete', 'fs:share'];

/** Permits every fs permission for alice; its permits expire at `expires` when set. */
class ExpiringModel extends AuthorizationModel {
  readonly name = 'expiring';
  readonly capabilities: ModelCapabilities = { effects: ['permit'], residuals: [], sync: 'always', fields: false, needsSubject: false };

  constructor(private readonly expires?: Date) {
    super();
  }

  init(): void {}

  applies(): boolean {
    return true;
  }

  evaluate(req: DecisionRequest): Vote {
    const permits = req.principal.id === 'alice';
    return { model: this.name, permitWhen: permits ? TRUE : FALSE, denyWhen: FALSE, cacheable: true, ...(permits && this.expires ? { validUntil: this.expires } : {}) };
  }

  async summarize(principal: Principal): Promise<ModelSummary> {
    return { model: this.name, permissions: principal.id === 'alice' ? FS_ALL.map((name) => ({ name, conditional: false })) : [] };
  }
}

let seq = 0;

describe('authz-fs signed URLs through the engine', function () {
  this.timeout(20000);

  let owns = false;
  let undoLog: () => void;
  let domains: Awaited<ReturnType<typeof testHost.domains>>;
  let scope: IContainer;
  let name: string;
  const keys: string[][] = [];

  const set = (path: string[], value: unknown): void => {
    testHost.config().set(path, value);
    keys.push(path);
  };

  before(async () => {
    try {
      testHost.config();
    } catch {
      owns = true;
      await testHost.installHost();
    }
    undoLog = installQuietLog();
    domains = await testHost.domains();
  });

  after(async () => {
    undoLog();
    if (owns) await testHost.uninstallHost();
  });

  beforeEach(() => {
    scope = DI.child();
  });

  afterEach(async () => {
    if (domains.names().includes(name)) await domains.container(name).dispose();
    for (const path of keys.splice(0).reverse()) testHost.config().unset(path);
    await scope.dispose();
  });

  const setup = async (model: ExpiringModel, entry: Record<string, unknown>): Promise<{ g: fs; calls: Call[] }> => {
    name = `signed-${++seq}`;
    set(['authz', 'domains', name], { combine: { default: { algorithm: 'deny-overrides', models: ['expiring'] } }, cache: { maxEntries: 0 } });
    const child = domains.create(name);
    child.register(testHost.instance(model)).as(AuthorizationModel);
    child.register(testHost.instance({ now: () => NOW })).as(AuthzClock);
    const svc: AuthzService = await domains.service(name);
    const calls: Call[] = [];
    // `now` is left out: the guard reads the clock of the filesystem's domain.
    const g = guardFs(signer('uploads', calls), 'uploads', { config: parseFsAccessConfig('uploads', { mode: 'enforce', domain: name, ...entry }), container: scope, service: async () => svc, principal: () => alice });
    return { g, calls };
  };

  it("an expiring permit's validUntil caps the URL below the asked until and the TTL", async () => {
    const { g, calls } = await setup(new ExpiringModel(at(2)), { signedUrl: { maxTtlSeconds: 600 } });
    await g.signedUrl!('a.txt', { until: DateTime.fromJSDate(at(60)) });
    expect(untilOf(calls[0])).to.equal(at(2).getTime());
  });

  it('without a TTL config the decision validUntil alone sets until', async () => {
    const { g, calls } = await setup(new ExpiringModel(at(3)), {});
    await g.signedUrl!('a.txt');
    expect(untilOf(calls[0])).to.equal(at(3).getTime());
  });

  it('the TTL counts from the domain clock', async () => {
    const { g, calls } = await setup(new ExpiringModel(), { signedUrl: { maxTtlSeconds: 240 } });
    await g.signedUrl!('a.txt');
    expect(untilOf(calls[0])).to.equal(at(4).getTime());
  });

  it('a permit that never expires, no TTL and no asked until: the provider default', async () => {
    const { g, calls } = await setup(new ExpiringModel(), {});
    await g.signedUrl!('a.txt');
    expect(calls).to.deep.equal([['signedUrl', 'a.txt']]);
  });
});
