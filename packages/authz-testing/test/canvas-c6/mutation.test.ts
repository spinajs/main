import * as chai from 'chai';
import 'mocha';

import type { World } from '../../src/index.js';
import { canvasConformance, judgeConformance } from './conformance.js';
import { RULE_IDS } from './config.js';
import { loadCanvasFixtures } from './fixtures.js';
import { canvasHarness, canvasWorld } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();

interface Mutation {
  readonly kind: 'rule' | 'policy';
  readonly id: string;
}

const MUTATIONS: readonly Mutation[] = [...RULE_IDS.map((id): Mutation => ({ kind: 'rule', id })), { kind: 'policy', id: 'agents-disabled' }];

type Listed = { readonly id: string };

/** canvasWorld('memory') with one config rule (authz.rbac.rules) or ABAC policy (authz.abac.policies) left out. */
function mutated(m: Mutation): World {
  const world = canvasWorld('memory');
  const config = world.config as { rbac: { rules: Listed[] }; abac: { policies: Listed[] } } & Record<string, unknown>;
  const drop = <T extends Listed>(list: readonly T[]): T[] => {
    const kept = list.filter((x) => x.id !== m.id);
    if (kept.length !== list.length - 1) throw new Error(`mutation: ${m.kind} ${m.id} is not in the generated config`);
    return kept;
  };
  const changed = m.kind === 'rule' ? { rbac: { ...config.rbac, rules: drop(config.rbac.rules) } } : { abac: { ...config.abac, policies: drop(config.abac.policies) } };
  return { ...world, config: { ...config, ...changed } };
}

// The cases that stop conforming when the rule or policy is left out.
const FAILING: Readonly<Record<string, readonly string[]>> = {
  'file-grant-cap': [],
  'link-cap': [],
  'link-org-cap': ['policy caps the link role'],
  // GUS (ACME guest) stays at editor: guest-org-cap reads the default guest_max_role 'editor'.
  'guest-cap': ['guest never becomes maintainer'],
  'guest-org-cap': [],
  'external-cap': ['external is capped at commenter', 'external comments on a shared file'],
  'external-sharing-off': ['external sharing off cuts an existing external grant'],
  'guest-addons': ['policy strips guest add-ons', 'policy strips external add-ons'],
  'link-addons': ['policy strips link add-ons'],
  'link-members-only': ['org-only link refuses anonymous', 'policy turns off public links'],
  'no-download': ['no-download policy blocks viewer export', 'no-download policy reads the project role'],
  'editors-may-not-invite': ['policy stops editors inviting'],
  'delete-needs-org-admin': ['maintainer delete needs org admin'],
  'agents-disabled': ['org policy disables agents'],
};

// Coverage gaps of the canvas cases: no C6 state makes these rules cut anything, so each removal fails no case.
const SURVIVING: Readonly<Record<string, string>> = {
  'file-grant-cap': 'caps file-scope grants at editor; fixtures.ts FILE_GRANT_ROLES admits only viewer, commenter, editor',
  'link-cap': 'caps link grants at commenter; fixtures.ts LINK_ROLES admits only viewer, commenter',
  'guest-org-cap': "never cuts below guest-cap's editor: guest_max_role is the default 'editor' in ACME and OPEN, 'maintainer' in STRICT (state.json)",
};

describe('canvas C6 config rule mutations (memory)', function () {
  this.timeout(60000);
  const harness = canvasHarness({ store: 'memory' });
  const facets = harness.facets.filter((f) => f !== 'cache');
  const observed = new Map<string, string[]>();

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());

  /** One line per case that does not conform: `<name>: expected …, got …`. */
  async function failures(world: World, label: string): Promise<readonly string[]> {
    const session = await harness.setup(world, { id: 'B40', part: 'memory', case: label, title: `canvas C6 ${label}`, facets });
    try {
      const canvas = session.lane?.canvas;
      if (!canvas) throw new Error('the canvas harness gave no lane handle');
      return judgeConformance(await canvasConformance(canvas.facade, fixtures.cases), KNOWN_MISMATCHES.memory).unexpected;
    } finally {
      await session.dispose();
    }
  }

  it('the generated config conforms 64/64 (the baseline of every mutation)', async () => {
    expect(await failures(canvasWorld('memory'), 'generated config')).to.deep.equal([]);
  });

  for (const m of MUTATIONS) {
    it(`without ${m.kind} ${m.id}: the failing cases are the ones the table names`, async () => {
      const lines = await failures(mutated(m), `without ${m.kind} ${m.id}`);
      for (const line of lines) console.log(`  without ${m.id}: ${line}`);
      const failing = lines.map((line) => line.slice(0, line.indexOf(': ')));
      observed.set(m.id, failing);
      expect(failing).to.have.members([...(FAILING[m.id] ?? [])]);
    });
  }

  it('every rule and the policy is in the table, and exactly the surviving rules fail no case', () => {
    expect(Object.keys(FAILING)).to.have.members(MUTATIONS.map((m) => m.id));
    expect([...observed.keys()]).to.have.members(MUTATIONS.map((m) => m.id));
    expect([...observed].filter(([, failing]) => failing.length === 0).map(([id]) => id)).to.have.members(Object.keys(SURVIVING));
  });
});
