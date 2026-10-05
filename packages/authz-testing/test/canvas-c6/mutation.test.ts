import * as chai from 'chai';
import 'mocha';

import { SYSTEM } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';

import type { HarnessSession, World } from '../../src/index.js';
import { canvasConformance, judgeConformance } from './conformance.js';
import { RULE_IDS } from './config.js';
import type { AuthzCase } from './fixtures.js';
import { loadCanvasFixtures } from './fixtures.js';
import { canvasHarness, canvasWorld } from './harness.js';
import type { CanvasHandle } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();
const id = (symbol: string): string => fixtures.ids.get(symbol)!;

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

// C6 data cannot bind file-grant-cap, link-cap and guest-org-cap (fixtures.ts FILE_GRANT_ROLES and LINK_ROLES
// refuse the rows; no org sets guest_max_role below editor), so K1 writes such rows through AuthzAdmin itself.
const SUPPLEMENT_WRITES: readonly AuthzCommand[] = [
  { kind: 'assignment.grant', subject: { type: 'user', id: id('MIA') }, role: 'maintainer', scope: { type: 'file', id: id('SHARED') }, tags: ['inspect', 'code'], replaceLadder: true },
  // Without max_link_role above commenter, link-org-cap would cut the editor link just as link-cap does.
  { kind: 'scope.setAttributes', scope: { type: 'org', id: id('ACME') }, patch: { policies: { max_link_role: 'maintainer', guest_max_role: 'commenter' } } },
  { kind: 'link.create', scope: { type: 'project', id: id('WEB') }, role: 'editor', tags: [], expiresAt: null, attributes: { org_only: false } },
];
const LINK_WRITE = 2;

const S_FILE_GRANT = 'k1 supplement: a maintainer file grant gives editor';
const S_LINK = 'k1 supplement: an editor link gives commenter under max_link_role maintainer';
const S_GUEST = 'k1 supplement: guest_max_role commenter caps an org guest';

/** The supplement checks; the facade passes the link id AuthzAdmin gave through unmapped. */
function supplementCases(linkId: string): AuthzCase[] {
  return [
    { name: S_FILE_GRANT, principal: { kind: 'user', user: id('MIA') }, capability: 'file.edit', resource: { kind: 'file', file: id('SHARED') }, expected: { allowed: true, role: 'editor' } },
    { name: S_LINK, principal: { kind: 'link', link: linkId, user: null }, capability: 'comment.create', resource: { kind: 'project', project: id('WEB') }, expected: { allowed: true, role: 'commenter' } },
    { name: S_GUEST, principal: { kind: 'user', user: id('GUS') }, capability: 'file.edit', resource: { kind: 'project', project: id('WEB') }, expected: { allowed: false, reason: { code: 'role_too_low', role: 'commenter', needed: 'editor' } } },
  ];
}

// The supplements that fail when the rule or policy is left out.
const SUPPLEMENTS_FAILING: Readonly<Record<string, readonly string[]>> = {
  'file-grant-cap': [S_FILE_GRANT],
  'link-cap': [S_LINK],
  'link-org-cap': [],
  'guest-cap': [],
  'guest-org-cap': [S_GUEST],
  'external-cap': [],
  'external-sharing-off': [],
  'guest-addons': [],
  'link-addons': [],
  'link-members-only': [],
  'no-download': [],
  'editors-may-not-invite': [],
  'delete-needs-org-admin': [],
  'agents-disabled': [],
};

describe('canvas C6 config rule mutations (memory)', function () {
  this.timeout(60000);
  const harness = canvasHarness({ store: 'memory' });
  const facets = harness.facets.filter((f) => f !== 'cache');
  const observed = new Map<string, string[]>();
  const observedSupplements = new Map<string, string[]>();

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());

  async function inSession<T>(world: World, label: string, run: (canvas: CanvasHandle, session: HarnessSession) => Promise<T>): Promise<T> {
    const session = await harness.setup(world, { id: 'B40', part: 'memory', case: label, title: `canvas C6 ${label}`, facets });
    try {
      const canvas = session.lane?.canvas;
      if (!canvas) throw new Error('the canvas harness gave no lane handle');
      return await run(canvas, session);
    } finally {
      await session.dispose();
    }
  }

  /** One line per case that does not conform: `<name>: expected …, got …`. */
  const failures = (world: World, label: string): Promise<readonly string[]> => inSession(world, label, async (canvas) => judgeConformance(await canvasConformance(canvas.facade, fixtures.cases), KNOWN_MISMATCHES.memory).unexpected);

  /** The same over the supplements, in a world of their own: the canvas state plus the supplement writes. */
  const supplementFailures = (world: World, label: string): Promise<readonly string[]> =>
    inSession(world, `${label}, k1 supplements`, async (canvas, session) => {
      if (!session.admin) throw new Error('the canvas harness gave no AuthzAdmin');
      const results = await session.admin.execute(SYSTEM, SUPPLEMENT_WRITES, { reason: 'k1 supplement' });
      results.forEach((r, i) => {
        if (!r.ok) throw new Error(`k1 supplement write ${i} (${r.kind}) failed: ${r.error.code}: ${r.error.message}`);
      });
      const link = results[LINK_WRITE];
      if (!link?.ok || link.id === undefined) throw new Error('k1 supplement: link.create returned no id');
      return judgeConformance(await canvasConformance(canvas.facade, supplementCases(link.id)), {}).unexpected;
    });

  // Supplement names hold ': ' themselves; judgeConformance writes `<name>: expected …` for them.
  const supplementNames = (lines: readonly string[]): string[] => lines.map((line) => line.slice(0, line.indexOf(': expected')));

  it('the generated config conforms 64/64 (the baseline of every mutation)', async () => {
    expect(await failures(canvasWorld('memory'), 'generated config')).to.deep.equal([]);
  });

  it('the generated config passes the 3 k1 supplements', async () => {
    expect(await supplementFailures(canvasWorld('memory'), 'generated config')).to.deep.equal([]);
  });

  for (const m of MUTATIONS) {
    it(`without ${m.kind} ${m.id}: the failing cases are the ones the table names`, async () => {
      const lines = await failures(mutated(m), `without ${m.kind} ${m.id}`);
      for (const line of lines) console.log(`  without ${m.id}: ${line}`);
      const failing = lines.map((line) => line.slice(0, line.indexOf(': ')));
      observed.set(m.id, failing);
      expect(failing).to.have.members([...(FAILING[m.id] ?? [])]);
    });

    it(`without ${m.kind} ${m.id}: the failing k1 supplements are the ones the table names`, async () => {
      const lines = await supplementFailures(mutated(m), `without ${m.kind} ${m.id}`);
      for (const line of lines) console.log(`  without ${m.id}: ${line}`);
      const failing = supplementNames(lines);
      observedSupplements.set(m.id, failing);
      expect(failing).to.have.members([...(SUPPLEMENTS_FAILING[m.id] ?? [])]);
    });
  }

  it('every rule and the policy is in both tables, and each removal fails a case or a supplement', () => {
    const ids = MUTATIONS.map((m) => m.id);
    expect(Object.keys(FAILING)).to.have.members(ids);
    expect(Object.keys(SUPPLEMENTS_FAILING)).to.have.members(ids);
    expect([...observed.keys()]).to.have.members(ids);
    expect([...observedSupplements.keys()]).to.have.members(ids);
    const surviving = ids.filter((m) => observed.get(m)!.length === 0 && observedSupplements.get(m)!.length === 0);
    expect(surviving, 'rules whose removal fails no case and no supplement').to.deep.equal([]);
  });
});
