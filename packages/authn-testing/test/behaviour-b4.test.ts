import assert from 'node:assert/strict';
import 'mocha';
import { planCases, runAuthnBehaviour, settleCase } from '../src/behaviour/index.js';
import type { Facet, HarnessContext } from '../src/behaviour/index.js';
import { FakeIdentityStore, MemoryLinkStore, MemoryPasswordCredentialStore, fakeSeedPort } from '../src/fakes/index.js';
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
  });
});
