import { AuthzConfigError } from './errors.js';

export interface FieldMatcher {
  allows(path: string | readonly string[]): boolean;
}

const SEGMENT = '(?:\\*|[^.*!\\s]+)';
const GLOB = new RegExp(`^!?${SEGMENT}(?:\\.${SEGMENT})*$`, 'u');

export const isFieldGlob = (s: unknown): s is string => typeof s === 'string' && GLOB.test(s);

export const compileFieldGlobs = (globs: readonly string[]): FieldMatcher => {
  const trie = compile(globs.map(parse));
  return Object.freeze({
    allows: (path: string | readonly string[]): boolean => {
      const segs = typeof path === 'string' ? (path === '' ? [] : path.split('.')) : path;
      let cursor = start(trie);
      for (const seg of segs) {
        if (cursor.nodes.length === 0) break;
        cursor = step(cursor, seg);
      }
      return segs.length > 0 && cursor.value;
    },
  });
};

export const normalizeFieldGlobs = (globs: readonly string[]): string[] => combine([globs.map(parse)], ([v]) => v);

export const unionFieldGlobs = (...lists: readonly (readonly string[])[]): string[] =>
  combine(
    lists.map((l) => l.map(parse)),
    (vs) => vs.some(Boolean),
  );

export const subtractFieldGlobs = (from: readonly string[], remove: readonly string[]): string[] => combine([from.map(parse), remove.map(parse)], ([a, b]) => a && !b);

export function filterObject<T>(fields: readonly string[], data: readonly T[]): Partial<T>[];
export function filterObject<T>(fields: readonly string[], data: T): Partial<T>;
export function filterObject(fields: readonly string[], data: unknown): unknown {
  const root = start(compile(fields.map(parse)));
  const top = (v: unknown): unknown => (isPlainObject(v) ? filterPlain(v, root) : Array.isArray(v) ? v.map(top) : v);
  return top(data);
}

// A glob of n segments matches every path of m >= n segments whose first n
// segments it matches. For one path the most specific matching glob wins:
// more segments, then a literal over '*' at the first position where they
// differ, then a negation over a positive.

interface Glob {
  readonly segs: readonly string[];
  readonly allow: boolean;
}

interface Node {
  readonly id: number;
  readonly lit: Map<string, Node>;
  star?: Node;
  sign?: boolean;
  live: boolean; // some glob ends in this subtree
  readonly covers: Map<Node, boolean>;
}

// The trie nodes at the current depth that match the path so far, most
// specific first; value is the decision for a path ending here.
interface Cursor {
  readonly nodes: readonly Node[];
  readonly value: boolean;
}

const parse = (glob: string): Glob => {
  if (!isFieldGlob(glob)) {
    throw new AuthzConfigError(`Invalid field glob ${typeof glob === 'string' ? JSON.stringify(glob) : String(glob)}: expected an optional '!' and '.'-separated segments, each '*' or a run of characters other than '.', '*', '!' and whitespace`);
  }

  const allow = !glob.startsWith('!');
  return { segs: (allow ? glob : glob.slice(1)).split('.'), allow };
};

const compile = (globs: readonly Glob[]): Node => {
  let ids = 0;
  const node = (): Node => ({ id: ids++, lit: new Map(), live: false, covers: new Map() });
  const root = node();

  for (const { segs, allow } of globs) {
    let n = root;
    for (const seg of segs) {
      let next = seg === '*' ? n.star : n.lit.get(seg);
      if (next === undefined) {
        next = node();
        if (seg === '*') n.star = next;
        else n.lit.set(seg, next);
      }
      n = next;
    }
    n.sign = n.sign !== false && allow;
  }

  const mark = (n: Node): boolean => {
    let live = n.sign !== undefined;
    for (const c of n.lit.values()) live = mark(c) || live;
    if (n.star) live = mark(n.star) || live;
    return (n.live = live);
  };
  mark(root);
  return root;
};

const start = (root: Node): Cursor => ({ nodes: root.live ? [root] : [], value: false });

// Literal children come before the star child, which keeps the order most
// specific first: the paths agree up to here and differ at this position.
const step = (cursor: Cursor, seg: string | undefined, reduce = false): Cursor => {
  if (cursor.nodes.length === 0) return cursor;

  let nodes: Node[] = [];
  for (const n of cursor.nodes) {
    const l = seg === undefined ? undefined : n.lit.get(seg);
    if (l?.live) nodes.push(l);
    if (n.star?.live) nodes.push(n.star);
  }
  if (reduce) nodes = nodes.filter((u, i) => !nodes.some((v, j) => j < i && covers(v, u)));

  let value = cursor.value;
  for (const n of nodes) {
    if (n.sign !== undefined) {
      value = n.sign;
      break;
    }
  }
  return { nodes, value };
};

// v covers u (both at one depth) when, for every continuation, v's subtree
// has a glob ending wherever u's has one. A covered node that comes after
// its cover can never decide, so dropping it keeps the decisions; without
// this, lists such as 'k' at each of n positions reach 2^n node sets.
const covers = (v: Node, u: Node): boolean => {
  if (!u.live || v === u) return true;
  let r = v.covers.get(u);
  if (r === undefined) {
    r = (u.sign === undefined || v.sign !== undefined) && (!u.star?.live || (v.star !== undefined && covers(v.star, u.star)));
    if (r) {
      for (const [x, uc] of u.lit) {
        const vc = v.lit.get(x);
        if (uc.live && !((vc !== undefined && covers(vc, uc)) || (v.star !== undefined && covers(v.star, uc)))) {
          r = false;
          break;
        }
      }
    }
    v.covers.set(u, r);
  }
  return r;
};

// Exact boolean combination of glob lists. The cursors of all lists walk
// together; each reachable state is reduced to a canonical node keyed by its
// own decision, the node for keys no glob names ('other') and the literal
// children that behave differently from 'other'. Equal meanings give equal
// canonical nodes, so the emitted list depends only on the meaning.
const combine = (lists: readonly (readonly Glob[])[], op: (values: readonly boolean[]) => boolean): string[] => {
  const dag = new Dag();
  const target = dag.build(lists, op);
  return dag.prune(dag.emit(target), target).map(format);
};

interface Canon {
  readonly value: boolean;
  readonly other: number;
  readonly lits: readonly (readonly [string, number])[];
}

const FALSE_ID = 0;
const TRUE_ID = 1;

class Dag {
  private readonly nodes: Canon[] = [
    { value: false, other: FALSE_ID, lits: [] },
    { value: true, other: TRUE_ID, lits: [] },
  ];
  private readonly ids = new Map<string, number>();

  build(lists: readonly (readonly Glob[])[], op: (values: readonly boolean[]) => boolean): number {
    const memo = new Map<string, number>();

    const visit = (cursors: readonly Cursor[], depth: number): number => {
      const value = depth > 0 && op(cursors.map((c) => c.value));
      if (depth > 0 && cursors.every((c) => c.nodes.length === 0)) return value ? TRUE_ID : FALSE_ID;

      const key = `${depth > 0 ? +value : 'r'}|${cursors.map((c) => `${+c.value}:${c.nodes.map((n) => n.id).join(',')}`).join('|')}`;
      const known = memo.get(key);
      if (known !== undefined) return known;

      const names = new Set<string>();
      for (const c of cursors) for (const n of c.nodes) for (const x of n.lit.keys()) names.add(x);

      const other = visit(
        cursors.map((c) => step(c, undefined, true)),
        depth + 1,
      );
      const lits: [string, number][] = [];
      for (const x of [...names].sort(compareStrings)) {
        const id = visit(
          cursors.map((c) => step(c, x, true)),
          depth + 1,
        );
        if (id !== other) lits.push([x, id]);
      }

      const id = this.intern(value, other, lits);
      memo.set(key, id);
      return id;
    };

    return visit(
      lists.map((l) => start(compile(l))),
      0,
    );
  }

  // Unrolls the canonical graph into one glob per path class. A constant
  // branch still runs on as a '*' chain while a '*' sibling of one of its
  // ancestors emits deeper globs: those would match its paths and outrank
  // the shorter glob (more segments win).
  emit(rootId: number): Glob[] {
    const heights = new Map<number, number>();
    const height = (id: number): number => {
      if (id === FALSE_ID || id === TRUE_ID) return 0;
      let h = heights.get(id);
      if (h === undefined) {
        const n = this.nodes[id];
        h = 1 + Math.max(height(n.other), ...n.lits.map(([, c]) => height(c)));
        heights.set(id, h);
      }
      return h;
    };

    const out: Glob[] = [];
    const walk = (id: number, segs: string[], need: number) => {
      const n = this.nodes[id];
      if (segs.length > 0) out.push({ segs, allow: n.value });
      if ((id === FALSE_ID || id === TRUE_ID) && segs.length >= need) return;
      const inner = Math.max(need, segs.length + 1 + height(n.other));
      for (const [x, c] of n.lits) walk(c, [...segs, x], inner);
      walk(n.other, [...segs, '*'], need);
    };
    walk(rootId, [], 0);
    return out;
  }

  // Drops globs while the meaning stays the same: whole runs first (most
  // emitted globs go), then one at a time until no single glob can go.
  prune(globs: readonly Glob[], target: number): Glob[] {
    const sorted = [...globs].sort(compareGlobs);
    const kept = new Set(sorted);
    const tryDrop = (run: readonly Glob[]): boolean => {
      for (const g of run) kept.delete(g);
      if (this.build([sorted.filter((g) => kept.has(g))], ([v]) => v) === target) return true;
      for (const g of run) kept.add(g);
      return false;
    };
    const split = (run: readonly Glob[]): void => {
      if (run.length === 0 || tryDrop(run) || run.length === 1) return;
      split(run.slice(0, run.length >> 1));
      split(run.slice(run.length >> 1));
    };

    split(sorted);
    for (let changed = true; changed; ) {
      changed = false;
      for (const g of sorted) {
        if (kept.has(g) && tryDrop([g])) changed = true;
      }
    }
    return sorted.filter((g) => kept.has(g));
  }

  private intern(value: boolean, other: number, lits: readonly (readonly [string, number])[]): number {
    const constant = value ? TRUE_ID : FALSE_ID;
    if (other === constant && lits.length === 0) return constant;

    const key = `${+value}|${other}|${lits.map(([x, c]) => `${JSON.stringify(x)}:${c}`).join(',')}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nodes.push({ value, other, lits }) - 1;
      this.ids.set(key, id);
    }
    return id;
  }
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Least specific first; the same order the decision rule uses.
const compareGlobs = (a: Glob, b: Glob): number => {
  if (a.segs.length !== b.segs.length) return a.segs.length - b.segs.length;
  for (let i = 0; i < a.segs.length; i++) {
    const aStar = a.segs[i] === '*';
    const bStar = b.segs[i] === '*';
    if (aStar !== bStar) return aStar ? -1 : 1;
  }
  for (let i = 0; i < a.segs.length; i++) {
    const c = compareStrings(a.segs[i], b.segs[i]);
    if (c !== 0) return c;
  }
  return +!a.allow - +!b.allow;
};

const format = (g: Glob): string => (g.allow ? '' : '!') + g.segs.join('.');

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const DROP = Symbol('drop');

const filterPlain = (obj: Record<string, unknown>, cursor: Cursor): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = filterValue(obj[key], step(cursor, key));
    // defineProperty: a plain assignment to '__proto__' would set the prototype
    if (value !== DROP) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
};

const filterValue = (v: unknown, cursor: Cursor): unknown => {
  if (isPlainObject(v)) {
    const out = filterPlain(v, cursor);
    return cursor.value || Object.keys(out).length > 0 ? out : DROP;
  }
  if (Array.isArray(v)) {
    const { out, any } = filterArray(v, cursor);
    return cursor.value || any ? out : DROP;
  }
  return cursor.value ? v : DROP;
};

// Object elements stay (possibly empty) so positions keep their meaning;
// any reports whether something below the array path survived.
const filterArray = (arr: readonly unknown[], cursor: Cursor): { readonly out: unknown[]; readonly any: boolean } => {
  const out: unknown[] = [];
  let any = false;
  for (const el of arr) {
    if (isPlainObject(el)) {
      const o = filterPlain(el, cursor);
      any ||= Object.keys(o).length > 0;
      out.push(o);
    } else if (Array.isArray(el)) {
      const a = filterArray(el, cursor);
      any ||= a.any;
      out.push(a.out);
    } else if (cursor.value) {
      any = true;
      out.push(el);
    }
  }
  return { out, any };
};
