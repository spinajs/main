import 'mocha';
import { expect } from 'chai';
import { planCases, runAuthnBehaviour } from '@spinajs/authn-testing';

import { PORTS, ROUTES, bootBehaviourApp, httpHarness, shutdownBehaviourApp, supports } from './harness.js';

/**
 * The README's N8a facets but A09/http: two of its cases need N8b's routes (tokenList, mfaEnrol) and the kit claims
 * whole facets, so they stay pending; every other A09/http case runs and must pass (pinned below).
 */
const CLAIM = ['A02/core', 'A02/http', 'A05/core', 'A05/http', 'A07/http', 'A08/http', 'A15/core', 'A20/http', 'A22/http', 'A23/http', 'A26/http', 'A31/http', 'A31/config'] as const;

const RULES = ['A02', 'A05', 'A07', 'A08', 'A09', 'A15', 'A20', 'A22', 'A23', 'A26', 'A31'] as const;

// A02/local (N3) times argon2 against unknown logins; over the kit's fake strategy that measures nothing and can flake.
const FACETS = [...new Set(planCases([...RULES]).map((p) => p.kase.facet))].filter((f) => f !== 'A02/local');

/** `<facet> <need>` of every case left pending here; the need comes from N10, N2 and N8b. */
const EXPECTED_PENDING = ['A02/external external', 'A07/store sessionStorage', 'A09/http http.routes.mfaEnrol', 'A09/http http.routes.tokenList'];

const SR_CASES = [
  'A05 SR-03 spoofed X-Forwarded-For is ignored',
  'A09 SR-07 pending whoami shows only MfaRequired',
  'A09 SR-07 pending session cannot impersonate',
  'A20 SR-06 impersonation expires after maxMinutes',
  'A20 SR-06 banning the impersonator ends the impersonation',
  'A22 SR-12 cross-origin cookie POST refused',
  'A31 SR-12 empty CORS list sends no CORS headers: origins []',
];

const have = (need: string): boolean => (need.startsWith('http.routes.') ? need.slice('http.routes.'.length) in ROUTES : need === 'fakeDate' || (PORTS as readonly string[]).includes(need));

describe('N8a behaviour rules over HTTP (test/v3-app)', function () {
  before(async function () {
    this.timeout(60000);
    await bootBehaviourApp();
  });

  after(async function () {
    this.timeout(60000);
    await shutdownBehaviourApp();
  });

  it('the only pending cases are those needing external, sessionStorage or the N8b routes tokenList and mfaEnrol; every SR case runs', () => {
    const planned = planCases([...RULES], { facets: FACETS });
    const missing = planned.flatMap((p) => p.kase.needs.filter((n) => !have(n)).map((n) => `${p.kase.facet} ${n}`));
    expect([...new Set(missing)].sort()).to.deep.eq(EXPECTED_PENDING);
    if (!missing.some((m) => m.startsWith('A09/http '))) expect(CLAIM, 'A09/http has every need now: claim it').to.include('A09/http');
    // A config computed from the prepared state cannot be checked before the case runs.
    const unsupported = planned.filter((p) => typeof p.kase.config === 'object' && !supports(p.kase.config)).map((p) => p.kase.name);
    expect(unsupported, 'cases the harness config cannot apply go pending').to.deep.eq([]);
    const sr = planned.filter((p) => / SR-\d+ /.test(p.kase.name));
    expect(sr.map((p) => p.kase.name)).to.include.members(SR_CASES);
    expect(sr.filter((p) => p.kase.needs.some((n) => !have(n))).map((p) => p.kase.name)).to.deep.eq([]);
  });

  runAuthnBehaviour([...RULES], httpHarness, { title: 'authn-http: plan list (N8a task 8)', claim: [...CLAIM], facets: FACETS });
});
