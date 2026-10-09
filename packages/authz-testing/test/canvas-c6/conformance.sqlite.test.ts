import * as chai from 'chai';
import 'mocha';

import { SYSTEM, principalKey } from '@spinajs/authz';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '../../src/index.js';
import type { BehaviourHarness, HarnessSession } from '../../src/index.js';
import { B40Sqlite, canvasConformance, judgeConformance } from './conformance.js';
import { countRows, rawQuery } from './db.js';
import { loadCanvasFixtures } from './fixtures.js';
import { canvasHarness, canvasWorld } from './harness.js';
import type { CanvasHandle } from './harness.js';
import { KNOWN_MISMATCHES } from './mismatches.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();
const id = (symbol: string): string => fixtures.ids.get(symbol)!;

// Hand-counted from state.json plus the extra-cases.json state (SEALED, VAULT).
const EXPECTED_ROWS = {
  // members 9 + 4 + 2, group members 1, project grants 4 + 3 + 1 (WEB, LOCKED, OPENPROJ) + 1 (VAULT),
  // file grants 3 + 1 + 2, default roles 2 (WEB, LOCKED), link grants 6
  authz_assignment: 15 + 1 + 9 + 6 + 2 + 6,
  authz_link: 6,
  // restrict on SECRET, and a push and a merge row for each of WEB's 4 branch patterns
  authz_rule: 1 + 8,
  // SECRET's allow list (ED); the branch rows list no subjects
  authz_rule_subject: 1,
  // explicit policy leaves: STRICT 5, OPEN 3, SEALED 1 (ACME sets none)
  authz_scope_attribute: 5 + 3 + 1,
};

const WEB = fixtures.state.projects.get(id('WEB'))!;
const BRANCH_RULE_IDS = WEB.branch_rules.flatMap((r) => [`branch:${id('WEB')}:${r.pattern}:push`, `branch:${id('WEB')}:${r.pattern}:merge`]);

async function openSession(harness: BehaviourHarness, title: string): Promise<{ session: HarnessSession; canvas: CanvasHandle; driver: OrmDriver; ms: number }> {
  await harness.beforeAll?.();
  const started = Date.now();
  const session = await harness.setup(canvasWorld('sqlite'), { id: 'B40', part: 'sqlite', case: title, title, facets: [...harness.facets] });
  const canvas = session.lane?.canvas;
  if (!canvas?.driver) throw new Error('the sqlite canvas harness gave no lane handle with a driver');
  return { session, canvas, driver: canvas.driver, ms: Date.now() - started };
}

async function close(harness: BehaviourHarness, session: HarnessSession | undefined): Promise<void> {
  try {
    await session?.dispose();
  } finally {
    await harness.afterAll?.();
  }
}

describe('canvas C6 conformance (sqlite)', function () {
  this.timeout(120000);
  const harness = canvasHarness({ store: 'sqlite' });
  let session: HarnessSession | undefined;
  let canvas: CanvasHandle;
  let driver: OrmDriver;

  before(async () => {
    const opened = await openSession(harness, 'all cases in one system');
    ({ session, canvas, driver } = opened);
    console.log(`  boot and load through AuthzAdmin on SQLite: ${opened.ms} ms`);
  });

  after(() => close(harness, session));

  it('all 64 cases answer as canvas expects, with no known mismatches (B40)', async () => {
    const started = Date.now();
    const result = await canvasConformance(canvas.facade, fixtures.cases);
    const verdict = judgeConformance(result, KNOWN_MISMATCHES.sqlite);
    for (const line of result.failures) console.log(`  mismatch: ${line}`);
    const known = verdict.known.length > 0 ? verdict.known.join(', ') : 'none';
    console.log(`  ${verdict.conform}/${verdict.cases} conform on SQLite; known mismatches: ${known} (${Date.now() - started} ms for 64 checks)`);
    expect(verdict.unexpected).to.deep.equal([]);
    expect(verdict).to.deep.include({ conform: 64, cases: 64, known: [] });
  });

  it('AuthzAdmin wrote the state into the authz tables: the row counts the state implies', async () => {
    const counts: Record<string, number> = {};
    for (const table of Object.keys(EXPECTED_ROWS)) counts[table] = await countRows(driver, table);
    expect(counts).to.deep.equal(EXPECTED_ROWS);
    expect(await countRows(driver, 'authz_admin_idempotency')).to.equal(0);
  });

  it('the rule rows are the restrict row and the eight branch rows', async () => {
    const rows = (await rawQuery(driver, 'SELECT id, kind, reason_code FROM authz_rule ORDER BY id')) as { id: string; kind: string; reason_code: string | null }[];
    expect(rows.map((r) => r.id)).to.have.members([`restrict:file:${id('SECRET')}`, ...BRANCH_RULE_IDS]);
    for (const r of rows) expect([r.kind, r.reason_code], r.id).to.deep.equal(r.id.startsWith('branch:') ? ['threshold', 'branch_protected'] : ['restrict', null]);
  });

  // DbRuleStore keeps the whole reason in `definition`; only fromSqlForm, the list compilation path, reads
  // `reason_code` alone.
  it('the branch rows keep their whole reason (pattern, needed) in authz_rule.definition', async () => {
    const rows = (await rawQuery(driver, "SELECT id, definition FROM authz_rule WHERE id LIKE 'branch:%'")) as { id: string; definition: string }[];
    const want = WEB.branch_rules.flatMap((r) => [
      [`branch:${id('WEB')}:${r.pattern}:push`, { code: 'branch_protected', pattern: r.pattern, needed: r.push_role, priority: 700, sortKey: r.pattern }],
      [`branch:${id('WEB')}:${r.pattern}:merge`, { code: 'branch_protected', pattern: r.pattern, needed: r.merge_role, priority: 700, sortKey: r.pattern }],
    ]);
    expect(rows.map((r) => [r.id, (JSON.parse(r.definition) as { reason: unknown }).reason])).to.have.deep.members(want);
  });

  it('every authz_link row carries org_only in its attributes (L1b)', async () => {
    const rows = (await rawQuery(driver, 'SELECT attributes FROM authz_link')) as { attributes: string | null }[];
    const flags = rows.map((r) => (JSON.parse(String(r.attributes)) as { org_only?: unknown }).org_only);
    expect(flags).to.have.length(6);
    for (const f of flags) expect(f).to.be.a('boolean');
    expect(flags.filter((f) => f === true)).to.have.length([...fixtures.state.links.values()].filter((l) => l.org_only).length);
  });

  it('no row was written outside AuthzAdmin: every row carries the loader actor (SYSTEM)', async () => {
    const system = principalKey(SYSTEM);
    const stamps = async (sql: string) => ((await rawQuery(driver, sql)) as { by: string | null }[]).map((r) => r.by);
    const assignments = (await rawQuery(driver, 'SELECT granted_by AS by, source FROM authz_assignment')) as { by: string | null; source: string }[];
    expect([...new Set(assignments.map((r) => `${r.by} ${r.source}`))]).to.deep.equal([`${system} db`]);
    expect([...new Set(await stamps('SELECT created_by AS by FROM authz_link'))]).to.deep.equal([system]);
    expect([...new Set(await stamps('SELECT created_by AS by FROM authz_rule'))]).to.deep.equal([system]);
    expect([...new Set(await stamps('SELECT updated_by AS by FROM authz_scope_attribute'))]).to.deep.equal([system]);
  });
});

describe('canvas C6 on SQLite: the restriction comes from the authz_rule row', function () {
  this.timeout(120000);
  const harness = canvasHarness({ store: 'sqlite' });
  let session: HarnessSession | undefined;

  after(() => close(harness, session));

  it('deleting the SECRET restrict row with raw SQL and publishing the change gives MIA the org default role', async () => {
    const opened = await openSession(harness, 'restrict rule row');
    session = opened.session;
    const c = fixtures.cases.find((x) => x.name === 'restriction drops project access')!;
    const ask = () => opened.canvas.facade.can(c.principal, c.capability, c.resource);
    expect(await ask()).to.deep.equal(c.expected);

    const rule = `restrict:file:${id('SECRET')}`;
    await rawQuery(opened.driver, 'DELETE FROM authz_rule_subject WHERE rule_id = ?', [rule], QueryContext.Delete);
    await rawQuery(opened.driver, 'DELETE FROM authz_rule WHERE id = ?', [rule], QueryContext.Delete);
    expect(await countRows(opened.driver, 'authz_rule')).to.equal(EXPECTED_ROWS.authz_rule - 1);
    // What AuthzAdmin publishes after a committed rule.delete; it drops the cached decision.
    await opened.session.bus!.publish({ domain: opened.session.domain, tags: [`rule:${rule}`], actor: { type: SYSTEM.type, id: SYSTEM.id }, at: new Date() });
    expect(await ask()).to.deep.equal({ allowed: true, role: 'viewer' });
  });
});

describe('canvas C6 on SQLite: branch protection comes from the authz_rule rows', function () {
  this.timeout(120000);
  const harness = canvasHarness({ store: 'sqlite' });
  let session: HarnessSession | undefined;

  after(() => close(harness, session));

  it('deleting the main push row with raw SQL and publishing the change lets ED push to main as editor', async () => {
    const opened = await openSession(harness, 'branch rule row');
    session = opened.session;
    const c = fixtures.cases.find((x) => x.name === 'main needs maintainer to push')!;
    const ask = () => opened.canvas.facade.can(c.principal, c.capability, c.resource);
    expect(await ask()).to.deep.equal(c.expected);

    const rule = `branch:${id('WEB')}:main:push`;
    await rawQuery(opened.driver, 'DELETE FROM authz_rule WHERE id = ?', [rule], QueryContext.Delete);
    expect(await countRows(opened.driver, 'authz_rule')).to.equal(EXPECTED_ROWS.authz_rule - 1);
    await opened.session.bus!.publish({ domain: opened.session.domain, tags: [`rule:${rule}`], actor: { type: SYSTEM.type, id: SYSTEM.id }, at: new Date() });
    expect(await ask()).to.deep.equal({ allowed: true, role: 'editor' });
  });
});

// A case takes under 1 s of CPU, but up to 22 s of wall time when the machine runs other suites at once; past
// mocha's 30 s the next case meets the timed-out case's domain still open.
runBehaviour(['B40.sqlite'], () => canvasHarness({ store: 'sqlite' }), { strict: true, fixtures: [...BEHAVIOUR_FIXTURES, B40Sqlite], timeoutMs: 180000 });
