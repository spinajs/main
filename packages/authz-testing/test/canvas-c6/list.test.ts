import * as chai from 'chai';
import 'mocha';

import { FALSE, TRUE } from '@spinajs/authz';

import { BEHAVIOUR_FIXTURES, runBehaviour } from '../../src/index.js';
import type { HarnessSession } from '../../src/index.js';
import { canvasConformance, judgeConformance } from './conformance.js';
import { loadCanvasFixtures } from './fixtures.js';
import { B40List, CANVAS_LISTS, DEFAULT_LISTS, DEFAULT_LIST_KEYS, FULL_LISTS, FULL_LISTS_ENV, judgeLists, listProblems, runCanvasLists, slowest } from './list.js';
import type { ListOutcome } from './list.js';
import { KNOWN_MISMATCHES, LIST_MISMATCHES } from './mismatches.js';
import { CanvasScopeResolver, branchRef } from './scope.js';
import { assertMirroredRows, canvasRows, canvasSqlHarness, canvasSqlWorld, jitSetting, requirePostgres } from './sql-harness.js';
import type { CanvasSqlKind } from './sql-harness.js';

const expect = chai.expect;
const fixtures = loadCanvasFixtures();
const id = (symbol: string): string => fixtures.ids.get(symbol)!;

describe('canvas C6 lists: rows and lists', () => {
  it('rows: the 4 orgs, 5 projects and 4 files of the state, and 13 branches (the cases name 4, the 4 branch-rule samples on HOME and SECRET add 7, main on SHARED in PRIVATE/ACME and on BRIEF in LOCKED/STRICT adds 2)', () => {
    const rows = canvasRows(fixtures);
    expect(rows.org.map((r) => fixtures.symbolOf(r.id))).to.have.members(['ACME', 'STRICT', 'OPEN', 'SEALED']);
    expect(rows.project.map((r) => fixtures.symbolOf(r.id))).to.have.members(['WEB', 'PRIVATE', 'LOCKED', 'OPENPROJ', 'VAULT']);
    expect(rows.file.map((r) => fixtures.symbolOf(r.id))).to.have.members(['HOME', 'SECRET', 'SHARED', 'BRIEF']);
    expect(rows.branch.map((r) => `${fixtures.symbolOf(String(r.file_id))}:${r.name}`)).to.have.members([
      'HOME:feature/x',
      'HOME:main',
      'HOME:release/1.0',
      'HOME:hotfix/2-lts',
      'HOME:release/x',
      'HOME:hotfix/x',
      'HOME:x-lts',
      'SECRET:main',
      'SECRET:release/x',
      'SECRET:hotfix/x',
      'SECRET:x-lts',
      'SHARED:main',
      'BRIEF:main',
    ]);
    const places = rows.branch.map((b) => {
      const file = rows.file.find((f) => f.id === b.file_id)!;
      expect([b.project_id, b.org_id], `${b.id}`).to.deep.equal([file.project_id, file.org_id]);
      return `${fixtures.symbolOf(b.project_id!)}/${fixtures.symbolOf(b.org_id!)}`;
    });
    // Outside WEB/ACME, so a branch list that ignores the project or org scope fails.
    expect([...new Set(places)]).to.have.members(['WEB/ACME', 'PRIVATE/ACME', 'LOCKED/STRICT']);
  });

  it('a branch whose file lies in another project gets no row: CanvasScopeResolver gives it no ancestors', async () => {
    const foreign = branchRef(id('WEB'), id('SHARED'), 'main');
    expect(await new CanvasScopeResolver(fixtures.state).ancestors(foreign)).to.equal(null);
    expect(canvasRows(fixtures).branch.map((r) => r.id)).to.not.include(foreign.id);
  });

  it(`the 64 cases ask ${CANVAS_LISTS.length} distinct (principal, permission, type) lists: org 4, project 23, file 29, branch 2`, () => {
    expect(CANVAS_LISTS.flatMap((l) => l.cases.map((c) => c.name))).to.have.members(fixtures.cases.map((c) => c.name));
    expect(new Set(CANVAS_LISTS.map((l) => l.key)).size).to.equal(CANVAS_LISTS.length);
    const perType = (t: string) => CANVAS_LISTS.filter((l) => l.type === t).length;
    expect([perType('org'), perType('project'), perType('file'), perType('branch')]).to.deep.equal([4, 23, 29, 2]);
    expect(DEFAULT_LISTS.map((l) => l.key)).to.deep.equal([...DEFAULT_LIST_KEYS]);
    expect(DEFAULT_LIST_KEYS.filter((k) => Object.hasOwn(LIST_MISMATCHES.sqlite, k)), 'a K1b-1 pin runs by default').to.have.lengthOf(1);
  });

  it('every pinned list mismatch names a list of the cases and an RFC', () => {
    for (const kind of ['sqlite', 'postgres'] as const) {
      for (const [key, k] of Object.entries(LIST_MISMATCHES[kind])) {
        expect(CANVAS_LISTS.map((l) => l.key), kind).to.include(key);
        expect(k.rfc).to.match(/^K1b-\d+$/);
        expect(k.problems).to.not.be.empty;
        expect(k.falseBecause).to.match(/^\S+ \S+ \(.+\)$/);
      }
    }
  });

  it('judgeLists holds a pin to its problems and its cause, and fails it once the list conforms', () => {
    const pins = LIST_MISMATCHES.sqlite;
    const key = DEFAULT_LIST_KEYS.find((k) => Object.hasOwn(pins, k))!;
    const list = CANVAS_LISTS.find((l) => l.key === key)!;
    const sql = { residual: FALSE, ids: [], statements: [], ms: 0 };
    const pinned: ListOutcome = { list, sql, rows: [id('HOME'), id('SECRET')], checked: [id('HOME')], conditional: [], falseBecause: [pins[key].falseBecause] };
    expect(listProblems(pinned)).to.deep.equal(pins[key].problems);
    expect(judgeLists([pinned], pins)).to.deep.include({ known: [`${key} (K1b-1)`], unexpected: [] });
    expect(judgeLists([{ ...pinned, checked: [] }], pins).unexpected).to.deep.equal([`${key}: known mismatch K1b-1 now conforms; remove it from LIST_MISMATCHES`]);
    expect(judgeLists([{ ...pinned, falseBecause: [] }], pins).unexpected).to.deep.equal([`${key}: known mismatch K1b-1 shows its problems, but the type-level denies are [], the pin expects ${JSON.stringify(pins[key].falseBecause)}`]);
    expect(judgeLists([{ ...pinned, sql: { ...sql, residual: TRUE, statements: ['SELECT 1'], returned: 0 } }], pins).unexpected).to.deep.equal([`${key}: known mismatch K1b-1 shows its problems, but the residual is true, the pin expects FALSE`]);
  });
});

function listSuite(kind: CanvasSqlKind): void {
  describe(`canvas C6 lists through authz-orm SQL (${kind}, one system; every list only with ${FULL_LISTS_ENV}=1)`, function () {
    // The full SQLite run takes about half an hour on a loaded machine.
    this.timeout(3600000);
    const harness = canvasSqlHarness(kind);
    let session: HarnessSession | undefined;
    let opened = false;

    before(async function () {
      if (kind === 'postgres') await requirePostgres(this);
      const started = Date.now();
      await harness.beforeAll!();
      opened = true;
      session = await harness.setup(canvasSqlWorld(kind), { id: 'B40', part: 'list', case: 'all lists in one system', title: `canvas C6 lists (${kind})`, facets: [...harness.facets] });
      console.log(`  boot, models and load through AuthzAdmin on ${kind}: ${Date.now() - started} ms`);
    });

    after(async () => {
      try {
        await session?.dispose();
      } finally {
        if (opened) await harness.afterAll!();
      }
    });

    it('authz-orm gives every model row the ancestors and attributes CanvasScopeResolver gives it, and GHOST, which has no row, null', async () => {
      expect(await assertMirroredRows(fixtures, canvasRows(fixtures))).to.deep.equal({ rows: 4 + 5 + 4 + 13, rowless: 1 });
    });

    if (kind === 'postgres') {
      it('the connection runs with jit off', async () => {
        expect(await jitSetting(session!)).to.equal('off');
      });
    }

    it('all 64 cases answer as canvas expects while authz-orm serves the canvas types, checked with the loaded row (B40)', async () => {
      const result = await canvasConformance(session!.lane!.canvas!.facade, fixtures.cases);
      const verdict = judgeConformance(result, KNOWN_MISMATCHES.sqlite);
      expect(verdict.unexpected).to.deep.equal([]);
      expect(verdict).to.deep.include({ conform: 64, cases: 64, known: [] });
    });

    const everyList = `every list (${CANVAS_LISTS.length}): one statement, exactly the rows check allows, each case resource iff allowed, read lists also through the middleware`;
    if (!FULL_LISTS) {
      // Pending, so the run names what it skipped; B40.list below runs DEFAULT_LISTS on SQLite.
      it(`${everyList} (skipped: set ${FULL_LISTS_ENV}=1)`);
      return;
    }

    it(everyList, async () => {
      const lists = CANVAS_LISTS;
      const started = Date.now();
      const run = await runCanvasLists(session!, lists);
      const verdict = judgeLists(run, LIST_MISMATCHES[kind]);
      console.log(`  ${kind}: ${verdict.summary} (${Date.now() - started} ms)`);
      for (const line of verdict.notListed) console.log(`  does not list: ${line}`);
      for (const line of verdict.known) console.log(`  known mismatch: ${line}`);
      for (const line of slowest(run, 5)) console.log(`  slow: ${line}`);
      expect(verdict.unexpected, verdict.unexpected.join('\n')).to.deep.equal([]);
      expect(verdict.notListed).to.deep.equal([]);
      expect(verdict.listed + verdict.known.length).to.equal(lists.length);
    });
  });
}

listSuite('sqlite');
listSuite('postgres');

runBehaviour(['B40.list'], () => canvasSqlHarness('sqlite'), { strict: true, fixtures: [...BEHAVIOUR_FIXTURES, B40List], timeoutMs: 300000 });
