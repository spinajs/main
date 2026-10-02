import assert from 'node:assert/strict';
import 'mocha';
import { planCases, runAuthnBehaviour, settleCase } from '../src/behaviour/index.js';
import type { Facet, HarnessContext, HarnessFactory, RuleId } from '../src/behaviour/index.js';
import { FakeIdentityStore, FakeImpersonationGuard, MemoryLinkStore, MemoryPasswordCredentialStore, fakeSeedPort } from '../src/fakes/index.js';
import { UnsupportedConfig } from '../src/harness/index.js';
import type { Harness } from '../src/harness/index.js';
import { referenceAccountLinks } from './reference/account-links.js';
import { referenceHarness } from './reference/harness.js';
import type { ReferenceExtras } from './reference/harness.js';
import { referenceHttpHarness } from './reference/http-app.js';
import { ReferenceLogSink, withLoginHints } from './reference/log-sink.js';

/** A19/store over MemoryLinkStore, the reference semantics of the link store facet (design §2.13). */
function linkStoreHarness(ctx: HarnessContext): Harness {
  if (Object.keys(ctx.config).length > 0) {
    throw new UnsupportedConfig(Object.keys(ctx.config));
  }
  return { seed: fakeSeedPort(new FakeIdentityStore(), new MemoryPasswordCredentialStore()), links: new MemoryLinkStore() };
}

/** The reference does not apply freshAuth; the account link port reads it from the case config instead. */
function withoutFreshAuth(ctx: HarnessContext): HarnessContext {
  const { freshAuth: _freshAuth, ...authn } = ctx.config.authn ?? {};
  return { ...ctx, config: { ...ctx.config, authn } };
}

const logSinkExtras =
  (sink: () => ReferenceLogSink = () => new ReferenceLogSink()): ((ctx: HarnessContext) => ReferenceExtras) =>
  (ctx) =>
  (base, parts) => {
    const logs = sink();
    parts.sinks.push(logs);
    return { logs, accountLinks: referenceAccountLinks(parts, ctx.config.authn?.freshAuth?.maxAgeSeconds), service: withLoginHints(base.service!, logs) };
  };

const coreFactory =
  (extras = logSinkExtras()) =>
  (ctx: HarnessContext): Harness =>
    referenceHarness(withoutFreshAuth(ctx), extras(ctx));

const CORE_FACETS: Facet[] = ['A19/core', 'A21/core', 'A23/core'];

runAuthnBehaviour(['A19'], linkStoreHarness, { title: 'kit fakes: MemoryLinkStore', facets: ['A19/store'], claim: ['A19/store'] });

runAuthnBehaviour(['A19', 'A21', 'A23'], coreFactory(), { title: 'reference: A19, A21 and A23 core facets', facets: CORE_FACETS, claim: CORE_FACETS });

runAuthnBehaviour(['A23'], (ctx) => referenceHttpHarness(ctx), { title: 'reference http app: A23/http', facets: ['A23/http'], claim: ['A23/http'] });

describe('A21 SR-19 mutant', () => {
  const NAME = 'A21 SR-19 failed logins log no login string';
  const plan = () => planCases(['A21'], { facets: ['A21/core'] }).filter((p) => p.kase.name === NAME);

  it('passes with the keyed-hash log sink', async () => {
    assert.strictEqual(plan().length, 1);
    const r = await settleCase(plan()[0], coreFactory());
    assert.strictEqual(r.status, 'passed', String(r.error));
  });

  it('fails when the log sink writes the login string as it is', async () => {
    const r = await settleCase(plan()[0], coreFactory(logSinkExtras(() => new ReferenceLogSink({ rawLogins: true }))));
    assert.strictEqual(r.status, 'failed');
    assert.ok(String(r.error).includes('holds a login string'), String(r.error));
  });
});

const named = (rule: RuleId, facet: Facet, name: string) => {
  const found = planCases([rule], { facets: [facet] }).filter((p) => p.kase.name === name);
  assert.strictEqual(found.length, 1, `one case named ${name}`);
  return found[0];
};

async function assertBites(rule: RuleId, facet: Facet, name: string, good: HarnessFactory, bad: HarnessFactory): Promise<void> {
  const ok = await settleCase(named(rule, facet, name), good);
  assert.strictEqual(ok.status, 'passed', `unmutated: ${String(ok.error)}`);
  const failed = await settleCase(named(rule, facet, name), bad);
  assert.strictEqual(failed.status, 'failed', 'mutated');
}

describe('A19 no-op account link port mutant', () => {
  const noop =
    (ctx: HarnessContext): ReferenceExtras =>
    (base, parts) => ({
      ...logSinkExtras()(ctx)(base, parts),
      accountLinks: {
        link: async (_s, external) => ({ ok: true, link: { id: 'kit-noop', identity: { type: 'user', id: 'nobody' }, provider: external.provider, subject: external.subject, linkedAt: new Date() } }),
        unlink: async () => ({ ok: true }),
      },
    });
  const bad = (ctx: HarnessContext) => coreFactory(noop)(ctx);

  for (const name of ["A19 linking needs the identity's own fresh session: fresh", 'A19 unlinking the last usable credential is refused: password and one link']) {
    it(`${name} fails`, () => assertBites('A19', 'A19/core', name, coreFactory(), bad));
  }
});

describe('A20 SR-06 expiry mutant', () => {
  const NAME = 'A20 SR-06 impersonation expires after maxMinutes';

  /** A stub ImpersonationPort over the reference parts; `stripOnly` expires by dropping the marker and keeping the target. */
  const factory =
    (stripOnly: boolean) =>
    (ctx: HarnessContext): Harness => {
      const maxMinutes = ctx.config.authn?.impersonation?.maxMinutes ?? 60;
      const { impersonation: _impersonation, ...authn } = ctx.config.authn ?? {};
      return referenceHarness(withoutFreshAuth({ ...ctx, config: { ...ctx.config, authn } }), (_b, parts) => {
        const started = new Map<string, number>();
        const guard = new FakeImpersonationGuard();
        return {
          guard,
          impersonation: {
            async start(session, target, c) {
              const from = await parts.sessions.restore(session.id);
              if (!from) return { ok: false };
              await parts.sessions.revoke(session);
              const next = await parts.sessions.issue(target, { ...from.facts, impersonator: { type: from.identity.type, id: from.identity.id } });
              started.set(next.id, c.now.getTime());
              return { ok: true, session: next };
            },
            async stop() {
              return null;
            },
            async principalOf(session, c) {
              const row = await parts.sessions.restore(session.id);
              if (!row) return null;
              if (c.now.getTime() - (started.get(session.id) ?? 0) > maxMinutes * 60_000) {
                await parts.events.publish({ type: 'impersonation.expire', at: c.now, outcome: 'success', identity: row.identity });
                return stripOnly ? parts.principals.principalOf(row.identity, { ...row.facts, impersonator: undefined }, {}) : null;
              }
              return parts.principals.principalOf(row.identity, row.facts, {});
            },
          },
        };
      });
    };

  it('fails when expiry only drops the impersonator marker', () => assertBites('A20', 'A20/core', NAME, factory(false), factory(true)));
});

describe('A12 identity layer refuses everything mutant', () => {
  const factory =
    (acceptsPlain: boolean) =>
    (ctx: HarnessContext): Harness => ({
      ...linkStoreHarness(ctx),
      identityMeta: { set: async (_id, key) => ({ ok: acceptsPlain && !key.includes(':pwd') && !/^(2fa|user:(2fa|pwd_reset|pwd|login|ban|invite)):/.test(key) }) },
    });

  it('A12 the identity layer accepts a plain key fails when every key is refused', () => assertBites('A12', 'A12/identity', 'A12 the identity layer accepts a plain key', factory(true), factory(false)));
});
