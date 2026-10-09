// Release gate 7: the canvas `file:read` list over 1,000 files and its 50-row pages, against the 3.0 limits and
// the 3.1 target (≤ 2 × the plain EXISTS query).
// One scenario per database, JIT mode, principal and operation; see ../BASELINE.md for what each one times.
import { PAGE_SIZE, PERMISSION, bootCanvasBench, canvasState, checkedFiles, plainExistsResidual } from '../lib.js';
import type { BenchScenario, CanvasBench, Statement } from '../lib.js';
import type { Kind } from '../../test/orm/root-orm.js';

// L4B_BENCH_BACKGROUND=<n>: n more orgs of other tenants in the authz tables (scenario names get .bg<n>).
const BACKGROUND = Number(process.env.L4B_BENCH_BACKGROUND ?? 0);
if (!Number.isSafeInteger(BACKGROUND) || BACKGROUND < 0) throw new Error(`L4B_BENCH_BACKGROUND must be a whole number, not ${process.env.L4B_BENCH_BACKGROUND}`);

const benches = new Map<Kind, Promise<CanvasBench>>();
const boot = (kind: Kind): Promise<CanvasBench> => {
  let b = benches.get(kind);
  if (!b) {
    b = bootCanvasBench(kind, 7, BACKGROUND).then(async (bench) => {
      // Verification and warm-up run with jit off unless a scenario says otherwise.
      if (kind === 'postgres') await bench.setJit(false);
      return bench;
    });
    benches.set(kind, b);
  }
  return b;
};

/** Closes every bench this module booted. */
export async function dispose(): Promise<void> {
  for (const b of benches.values()) await (await b).dispose();
  benches.clear();
}

interface Prepared {
  readonly bench: CanvasBench;
  readonly list: Statement;
  readonly plain: Statement;
  readonly plainResidual: Awaited<ReturnType<typeof plainExistsResidual>>;
  readonly listed: readonly string[];
  readonly reference: readonly string[];
  /** Offset of `page-middle`: the middle page of the list (0 for a list of one page). */
  readonly middle: number;
  /** Rows of `page-first`, `page-middle` and `exists-page-first`. */
  readonly pages: Readonly<Record<'first' | 'middle' | 'reference', number>>;
}

const middleOffset = (n: number) => PAGE_SIZE * Math.floor(Math.ceil(n / PAGE_SIZE) / 2);

// Verified once per database and principal: the list is exactly what single checks allow, inside the reference;
// each page is its slice of the list (or of the reference) in `updated_at DESC` order.
const prepared = new Map<string, Promise<Prepared>>();

function prepare(kind: Kind, who: string): Promise<Prepared> {
  const key = `${kind}:${who}`;
  let p = prepared.get(key);
  if (!p) {
    p = (async () => {
      const bench = await boot(kind);
      const principal = bench.state.principals.find((x) => x.name === who)!.principal;
      const residual = await bench.authz.filter(principal, PERMISSION, 'file');
      const plainResidual = plainExistsResidual(residual);
      const listed = await bench.list(principal);
      const reference = await bench.run(plainResidual, principal);
      const checked = await checkedFiles(bench, principal);
      const sorted = (xs: readonly string[]) => JSON.stringify([...xs].sort());
      if (sorted(listed) !== sorted(checked)) throw new Error(`${who}: the list (${listed.length}) is not what single checks allow (${checked.length})`);
      if (listed.length === 0) throw new Error(`${who}: lists nothing`);
      const missing = listed.filter((id) => !reference.includes(id));
      if (missing.length > 0) throw new Error(`${who}: the plain EXISTS misses ${missing.length} listed rows`);
      const [list] = await bench.statements(principal);
      const [plain] = await bench.statements(principal, plainResidual);
      const one = (s: Statement[] | undefined, what: string) => {
        if (!s || s.length !== 1) throw new Error(`${who}: ${what} ran ${s?.length ?? 0} statements, not one`);
      };
      one(await bench.statements(principal), 'the list');
      one(await bench.statements(principal, plainResidual), 'the plain EXISTS');

      const updated = new Map(bench.state.files.map((f) => [f.id, f.updated_at]));
      const recent = (xs: readonly string[]) => [...xs].sort((a, b) => (updated.get(b)! < updated.get(a)! ? -1 : 1));
      const middle = middleOffset(listed.length);
      const pages = { first: 0, middle: 0, reference: 0 };
      for (const [what, rows, all, offset] of [
        ['first', await bench.page(principal, 0), listed, 0],
        ['middle', await bench.page(principal, middle), listed, middle],
        ['reference', await bench.run(plainResidual, principal, 0), reference, 0],
      ] as const) {
        const want = recent(all).slice(offset, offset + PAGE_SIZE);
        if (JSON.stringify(rows) !== JSON.stringify(want)) throw new Error(`${who}: the ${what} page (${rows.length} rows at ${offset}) is not rows [${offset}, ${offset + PAGE_SIZE}) of its list by updated_at (${want.length})`);
        pages[what] = rows.length;
      }
      one(await bench.statements(principal, undefined, 0), 'the first page');
      one(await bench.statements(principal, undefined, middle), 'the middle page');
      one(await bench.statements(principal, plainResidual, 0), 'the plain EXISTS page');
      return { bench, list, plain, plainResidual, listed, reference, middle, pages };
    })();
    prepared.set(key, p);
  }
  return p;
}

type Op = 'list' | 'exists' | 'list-sql' | 'exists-sql' | 'page-first' | 'page-middle' | 'exists-page-first';

const PAGE_OPS: ReadonlySet<Op> = new Set(['page-first', 'page-middle', 'exists-page-first']);

const OPS: readonly { readonly op: Op; readonly compare?: Op; readonly what: string }[] = [
  { op: 'exists', what: 'reference (b): the r2 native:rbac.assignment v1 term (plain EXISTS, no rules) compiled by authz-orm on the file table and run' },
  { op: 'list', compare: 'exists', what: "(a): the list as an app runs it: File.query() under the principal, authz-orm's middleware filters project:read (args v2 with config and stored rules) and compiles it" },
  { op: 'exists-sql', what: "reference (b), the statement only: the plain EXISTS statement's text and bindings run on the driver" },
  { op: 'list-sql', compare: 'exists-sql', what: "(a), the statement only: the list statement's text and bindings run on the driver" },
  { op: 'exists-page-first', what: `reference (b) as a page: the plain EXISTS ordered by updated_at DESC, id ASC, limit ${PAGE_SIZE}, offset 0` },
  { op: 'page-first', what: `(a) as the first page: File.query() under the principal ordered by updated_at DESC, id ASC, limit ${PAGE_SIZE}, offset 0` },
  { op: 'page-middle', what: `(a) as the middle page: the same at offset ${PAGE_SIZE} × floor(pages / 2) of the principal's list` },
];

// JIT on compiles each list statement for seconds (L4b rules report): few iterations. Pages are fast, so they
// take more iterations on Postgres with JIT off for a p99 that means something.
const SIZING: Readonly<Record<string, { iterations: number; warmup: number; repeats: number }>> = {
  'postgres:off': { iterations: 30, warmup: 5, repeats: 3 },
  'postgres:off:page': { iterations: 100, warmup: 10, repeats: 3 },
  'postgres:on': { iterations: 10, warmup: 1, repeats: 1 },
  'sqlite:-': { iterations: 3, warmup: 1, repeats: 1 },
};

const MODES: readonly { readonly kind: Kind; readonly jit?: boolean }[] = [{ kind: 'postgres', jit: false }, { kind: 'postgres', jit: true }, { kind: 'sqlite' }];

const jitName = (jit: boolean | undefined) => (jit === undefined ? '-' : jit ? 'on' : 'off');
const nameOf = (kind: Kind, jit: boolean | undefined, who: string, op: Op) => `canvas${BACKGROUND > 0 ? `.bg${BACKGROUND}` : ''}.${kind}${jit === undefined ? '' : `.jit-${jitName(jit)}`}.${who}.${op}`;

const scenarios: BenchScenario[] = [];
for (const { kind, jit } of MODES) {
  for (const { name: who } of canvasState(7, BACKGROUND).principals) {
    for (const { op, compare, what } of OPS) {
      const mode = `${kind}:${jitName(jit)}`;
      const sizing = (PAGE_OPS.has(op) && SIZING[`${mode}:page`]) || SIZING[mode];
      let p: Prepared;
      const runOp = (): Promise<unknown> => {
        const principal = p.bench.state.principals.find((x) => x.name === who)!.principal;
        switch (op) {
          case 'list':
            return p.bench.list(principal);
          case 'exists':
            return p.bench.run(p.plainResidual, principal);
          case 'list-sql':
            return p.bench.execute(p.list);
          case 'exists-sql':
            return p.bench.execute(p.plain);
          case 'page-first':
            return p.bench.page(principal, 0);
          case 'page-middle':
            return p.bench.page(principal, p.middle);
          case 'exists-page-first':
            return p.bench.run(p.plainResidual, principal, 0);
        }
      };
      const rowsOf = (): number => {
        switch (op) {
          case 'page-first':
            return p.pages.first;
          case 'page-middle':
            return p.pages.middle;
          case 'exists-page-first':
            return p.pages.reference;
          default:
            return op.startsWith('list') ? p.listed.length : p.reference.length;
        }
      };
      scenarios.push({
        name: nameOf(kind, jit, who, op),
        description: `${kind}${jit === undefined ? '' : `, jit ${jitName(jit)}`}, ${who}: ${what}`,
        ...(compare ? { compare: nameOf(kind, jit, who, compare) } : {}),
        ...sizing,
        async setup() {
          p = await prepare(kind, who);
          if (jit !== undefined && p.bench.jit !== jit) await p.bench.setJit(jit);
        },
        async verify() {
          const rows = (await runOp()) as unknown[];
          const want = rowsOf();
          if (rows.length !== want) throw new Error(`${op} returned ${rows.length} rows, expected ${want}`);
        },
        run: runOp,
      });
    }
  }
}

export default scenarios;

/** What each booted database holds and runs with (counts, server, settings, indexes). */
export async function info(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [kind, b] of benches) out[kind] = await (await b).info();
  return out;
}
