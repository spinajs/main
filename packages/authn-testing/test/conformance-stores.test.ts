import assert from 'node:assert/strict';
import 'mocha';
import { runLinkStoreConformance, runSecretStoreConformance, runSessionIssuerConformance, runThrottleConformance } from '../src/conformance/index.js';
import { AUTHN_RULES } from '../src/behaviour/index.js';
import type { Facet, RuleId } from '../src/behaviour/index.js';
import { runSuite } from './reference/conformance-support.js';
import type { CaseOutcome } from './reference/conformance-support.js';
import { fakeStoreHarness, throttleHarness } from './reference/harness.js';

const UNTRANSCRIBED = ' [pending: not transcribed yet (PENDING_TRANSCRIPTION)]';

/** Titles the wrapper registers: each case of the facets, or one pending case for a rule still waiting for transcription. */
const titlesOf = (ids: RuleId[], facets: Facet[]) =>
  ids.flatMap((id) => {
    const cases = AUTHN_RULES.get(id)!.cases;
    return cases.length === 0 ? [`${id}${UNTRANSCRIBED}`] : cases.filter((c) => facets.includes(c.facet)).map((c) => c.name);
  });

const notGreen = (r: readonly CaseOutcome[]) => r.filter((c) => c.status === 'failed' || (c.status === 'pending' && !c.title.endsWith(UNTRANSCRIBED))).map((c) => `${c.title}: ${String(c.error)}`);

describe('store conformance wrappers', function () {
  this.timeout(300_000);

  it('runSessionIssuerConformance runs the claimed A07, A08 and A09 store facets green on MemorySessionIssuer', async () => {
    const r = await runSuite((bdd) => runSessionIssuerConformance((ctx) => fakeStoreHarness(ctx), { bdd }));
    assert.deepStrictEqual(notGreen(r), []);
    assert.deepStrictEqual(
      r.map((c) => c.title),
      titlesOf(['A07', 'A08', 'A09'], ['A07/store', 'A08/store', 'A09/store']),
    );
  });

  it('runSessionIssuerConformance claims its facets: a missing port fails', async () => {
    const r = await runSuite((bdd) => runSessionIssuerConformance(() => ({}), { bdd }));
    const transcribed = r.filter((c) => !c.title.endsWith(UNTRANSCRIBED));
    assert.ok(transcribed.length > 0 && transcribed.every((c) => c.status === 'failed'));
  });

  it('runThrottleConformance runs the claimed A05 and A06 store facets green on the reference throttle', async () => {
    const r = await runSuite((bdd) => runThrottleConformance((ctx) => throttleHarness(ctx), { bdd }));
    assert.deepStrictEqual(notGreen(r), []);
    assert.deepStrictEqual(
      r.map((c) => c.title),
      titlesOf(['A05', 'A06'], ['A05/store', 'A06/store']),
    );
  });

  it('the secret store and link store wrappers register their facets, or one visible pending case until B2 and B4', async () => {
    const secrets = await runSuite((bdd) => runSecretStoreConformance(() => ({}), { bdd }));
    const links = await runSuite((bdd) => runLinkStoreConformance(() => ({}), { bdd }));
    assert.deepStrictEqual(
      secrets.map((c) => c.title),
      titlesOf(['A11'], ['A11/store']),
    );
    assert.deepStrictEqual(
      links.map((c) => c.title),
      titlesOf(['A19'], ['A19/store']),
    );
    assert.ok(
      [...secrets, ...links].every((c) => c.status === (c.title.endsWith(UNTRANSCRIBED) ? 'pending' : 'failed')),
      'claimed: an empty harness fails once the rule has cases',
    );
  });
});
