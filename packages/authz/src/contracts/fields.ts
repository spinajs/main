import { AuthzConfigError } from './errors.js';

export interface FieldMatcher {
  allows(path: string | readonly string[]): boolean;
}

const SEGMENT = '(?:\\*|[^.*!\\s]+)';
const GLOB = new RegExp(`^!?${SEGMENT}(?:\\.${SEGMENT})*$`, 'u');

const MAX_GLOBS = 1000; // per list
const MAX_SEGMENTS = 32;
// Steps (roughly trie nodes visited) one union/subtract/normalize may take
// before it throws AuthzConfigError; at 50-200 ns a step a throw costs
// 0.1-0.3 s. This, not the caps above, is the real limit: the cost grows
// with the product of the literal counts the lists combine. Realistic field
// sets use about 2%, random depth-5 lists of 30-50 globs up to 77%,
// ['*', 300 x '!*.f'] with 100 x 'M.*' 95%; 300 x 300 throws. Callers
// should cache a failure per policy version.
const WORK_LIMIT = 1_500_000;

export const isFieldGlob = (s: unknown): s is string => typeof s === 'string' && GLOB.test(s);

export const compileFieldGlobs = (globs: readonly string[]): FieldMatcher => {
  const root = compile(parseList(globs), new Budget());
  return Object.freeze({
    allows: (path: string | readonly string[]): boolean => {
      const segs = typeof path === 'string' ? (path === '' ? [] : path.split('.')) : path;
      let cursor = start(root);
      for (const seg of segs) {
        if (cursor.nodes.length === 0) break;
        cursor = step(cursor, seg);
      }
      return segs.length > 0 && cursor.value;
    },
  });
};

export const normalizeFieldGlobs = (globs: readonly string[]): string[] => combine([parseList(globs)], ([v]) => v);

export const unionFieldGlobs = (...lists: readonly (readonly string[])[]): string[] =>
  combine(
    lists.map((l) => parseList(l)),
    (vs) => vs.some(Boolean),
  );

export const subtractFieldGlobs = (from: readonly string[], remove: readonly string[]): string[] => combine([parseList(from), parseList(remove)], ([a, b]) => a && !b);

export function filterObject<T>(fields: readonly string[], data: readonly T[]): Partial<T>[];
export function filterObject<T>(fields: readonly string[], data: T): Partial<T>;
export function filterObject(fields: readonly string[], data: unknown): unknown {
  const root: Cursors = [start(compile(parseList(fields), new Budget()))];
  const stack = new Set<object>();
  const top = (v: unknown, key: string): unknown => {
    const json = toJson(v, key);
    if (json === null || typeof json !== 'object') return json;
    if (!Array.isArray(json)) return filterRecord(json, root, stack);
    enter(stack, json);
    const out: unknown[] = [];
    for (let i = 0; i < json.length; i++) out.push(top(json[i], String(i)) ?? null);
    stack.delete(json);
    return out;
  };
  return top(data, '');
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
}

// The trie nodes at the current depth that match the path so far, most
// specific first; value is the decision for a path ending here.
interface Cursor {
  readonly nodes: readonly Node[];
  readonly value: boolean;
}

class Budget {
  private left = WORK_LIMIT;

  spend(n: number): void {
    this.left -= n;
    if (this.left < 0) throw new AuthzConfigError(`Field globs too complex: more than ${WORK_LIMIT} steps; use fewer globs or fewer '*' segments`);
  }
}

const describe = (value: unknown): string => {
  if (typeof value !== 'string') return `a value of type ${value === null ? 'null' : typeof value}`;
  return JSON.stringify(value.length > 64 ? `${value.slice(0, 64)}...` : value);
};

const parseList = (globs: readonly string[]): Glob[] => {
  if (!Array.isArray(globs)) throw new AuthzConfigError(`Field globs must be an array, got ${describe(globs)}`);
  if (globs.length > MAX_GLOBS) throw new AuthzConfigError(`Too many field globs: ${globs.length} (at most ${MAX_GLOBS} per list)`);
  const out: Glob[] = [];
  for (let i = 0; i < globs.length; i++) out.push(parse(globs[i]));
  return out;
};

const parse = (glob: unknown): Glob => {
  if (!isFieldGlob(glob)) {
    throw new AuthzConfigError(`Invalid field glob ${describe(glob)}: expected an optional '!' and '.'-separated segments, each '*' or a run of characters other than '.', '*', '!' and whitespace`);
  }

  const allow = !glob.startsWith('!');
  const segs = (allow ? glob : glob.slice(1)).split('.');
  if (segs.length > MAX_SEGMENTS) throw new AuthzConfigError(`Field glob ${describe(glob)} has ${segs.length} segments (at most ${MAX_SEGMENTS})`);
  return { segs, allow };
};

const compile = (globs: readonly Glob[], budget: Budget): Node => {
  let ids = 0;
  const node = (): Node => ({ id: ids++, lit: new Map(), live: false });
  const root = node();

  for (const { segs, allow } of globs) {
    budget.spend(segs.length);
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
// With covers, a node covered by an earlier one is dropped; nodes in keep
// are never dropped and never used as a cover.
const step = (cursor: Cursor, seg: string | undefined, budget?: Budget, covers?: Covers, keep?: ReadonlySet<Node>): Cursor => {
  if (cursor.nodes.length === 0) return cursor;

  let nodes: Node[] = [];
  for (const n of cursor.nodes) {
    const l = seg === undefined ? undefined : n.lit.get(seg);
    if (l?.live) nodes.push(l);
    if (n.star?.live) nodes.push(n.star);
  }
  budget?.spend(1 + nodes.length * (covers ? nodes.length : 1));
  if (covers) nodes = nodes.filter((u, i) => keep?.has(u) || !nodes.some((v, j) => j < i && !keep?.has(v) && covers(v, u)));

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
// this, lists such as 'k' at each of n positions reach 2^n node sets. The
// memo is valid while no sign changes.
type Covers = (v: Node, u: Node) => boolean;

const coverCheck = (budget: Budget): Covers => {
  const memo = new Map<Node, Map<Node, boolean>>();
  const covers: Covers = (v, u) => {
    if (!u.live || v === u) return true;
    let row = memo.get(v);
    if (row === undefined) memo.set(v, (row = new Map()));
    let r = row.get(u);
    if (r === undefined) {
      budget.spend(1 + u.lit.size);
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
      row.set(u, r);
    }
    return r;
  };
  return covers;
};

// Exact boolean combination of glob lists. The cursors of all lists walk
// together; each reachable state is reduced to a canonical node keyed by its
// own decision, the node for keys no glob names ('other') and the literal
// children that behave differently from 'other'. Equal meanings give equal
// canonical nodes, so the emitted list depends only on the meaning.
const combine = (lists: readonly (readonly Glob[])[], op: (values: readonly boolean[]) => boolean): string[] => {
  const budget = new Budget();
  const dag = new Dag(budget);
  return prune(dag.emit(dag.build(lists, op)), budget).map(format);
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

  constructor(private readonly budget: Budget) {}

  build(lists: readonly (readonly Glob[])[], op: (values: readonly boolean[]) => boolean): number {
    const memo = new Map<string, number>();
    const covers = coverCheck(this.budget);

    const visit = (cursors: readonly Cursor[], depth: number): number => {
      const value = depth > 0 && op(cursors.map((c) => c.value));
      if (depth > 0 && cursors.every((c) => c.nodes.length === 0)) return value ? TRUE_ID : FALSE_ID;

      const key = `${depth > 0 ? +value : 'r'}|${cursors.map((c) => `${+c.value}:${c.nodes.map((n) => n.id).join(',')}`).join('|')}`;
      const known = memo.get(key);
      if (known !== undefined) return known;

      const names = new Set<string>();
      for (const c of cursors) for (const n of c.nodes) for (const x of n.lit.keys()) names.add(x);

      const other = visit(
        cursors.map((c) => step(c, undefined, this.budget, covers)),
        depth + 1,
      );
      const lits: [string, number][] = [];
      for (const x of [...names].sort(compareStrings)) {
        const id = visit(
          cursors.map((c) => step(c, x, this.budget, covers)),
          depth + 1,
        );
        if (id !== other) lits.push([x, id]);
      }

      const id = this.intern(value, other, lits);
      memo.set(key, id);
      return id;
    };

    return visit(
      lists.map((l) => start(compile(l, this.budget))),
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
      if (segs.length > 0) {
        this.budget.spend(segs.length);
        out.push({ segs, allow: n.value });
      }
      if ((id === FALSE_ID || id === TRUE_ID) && segs.length >= need) return;
      const inner = Math.max(need, segs.length + 1 + height(n.other));
      for (const [x, c] of n.lits) walk(c, [...segs, x], inner);
      walk(n.other, [...segs, '*'], need);
    };
    walk(rootId, [], 0);
    return out;
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

// Drops globs, least specific first, while the meaning stays the same, until
// no single glob can go. The emitted patterns are distinct, so a glob is one
// trie node and dropping it clears that node's sign.
const prune = (globs: readonly Glob[], budget: Budget): Glob[] => {
  const sorted = [...globs].sort(compareGlobs);
  const root = compile(sorted, budget);
  const located = sorted.map((g) => {
    const path = new Set<Node>([root]);
    let target = root;
    for (const s of g.segs) {
      target = s === '*' ? target.star! : target.lit.get(s)!;
      path.add(target);
    }
    return { path, target };
  });
  const kept = sorted.map(() => true);
  let covers = coverCheck(budget);

  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < sorted.length; i++) {
      const { path, target } = located[i];
      if (kept[i] && redundant(root, sorted[i], target, path, covers, budget)) {
        target.sign = undefined;
        kept[i] = false;
        changed = true;
        covers = coverCheck(budget);
      }
    }
  }
  return sorted.filter((_, i) => kept[i]);
};

// Only paths that g matches can change, and only at g's own length: below
// that g does not match, and deeper the node sets are the same with or
// without g, so the decisions agree once they agree at g's length. Nodes on
// g's path neither drop nor cover, so the cover check (made with g's sign)
// holds both with and without g.
const redundant = (root: Node, g: Glob, target: Node, path: ReadonlySet<Node>, covers: Covers, budget: Budget): boolean => {
  budget.spend(g.segs.length);
  const seen = new Set<string>();
  const visit = (cursor: Cursor, depth: number, inherited: boolean): boolean => {
    if (depth === g.segs.length) {
      const signed = cursor.nodes.filter((n) => n.sign !== undefined);
      const without = signed.find((n) => n !== target);
      return (signed[0]?.sign ?? inherited) === (without?.sign ?? inherited);
    }

    const key = `${depth}|${+cursor.value}|${cursor.nodes.map((n) => n.id).join(',')}`;
    if (seen.has(key)) return true;
    seen.add(key);

    const next = (x: string | undefined) => visit(step(cursor, x, budget, covers, path), depth + 1, cursor.value);
    const seg = g.segs[depth];
    if (seg !== '*') return next(seg);
    const names = new Set<string>();
    for (const n of cursor.nodes) for (const x of n.lit.keys()) names.add(x);
    for (const x of names) if (!next(x)) return false;
    return next(undefined);
  };
  return visit(start(root), 0, false);
};

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

// filterObject sees a value the way JSON.stringify does, since its output
// is what gets serialised: toJSON(key) first (a model's dehydrate(), a
// date's ISO string), then primitives are leaves and any other object is a
// record of its own enumerable string keys rebuilt as a plain object. A
// toJSON that returns raw data is still filtered.

// All cursors must allow: a key with '.' is judged both as one segment and
// as the path its dots spell.
type Cursors = readonly Cursor[];

const DROP = Symbol('drop');

// undefined where JSON leaves the value out (or writes null in an array).
const toJson = (value: unknown, key: string): unknown => {
  let v = value;
  if (v !== null && (typeof v === 'object' || typeof v === 'function' || typeof v === 'bigint')) {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') v = toJSON.call(v, key);
  }
  if (typeof v === 'object' && v !== null) {
    if (hasSlot(Number.prototype.valueOf, v)) return Number(v);
    if (hasSlot(String.prototype.valueOf, v)) return String(v);
    if (hasSlot(Boolean.prototype.valueOf, v)) return Boolean.prototype.valueOf.call(v);
    if (hasSlot(BigInt.prototype.valueOf, v)) v = BigInt.prototype.valueOf.call(v);
  }
  if (typeof v === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
  return v === undefined || typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
};

// Boxed primitives: valueOf of the matching prototype throws on anything else.
const hasSlot = (valueOf: (this: never) => unknown, v: object): boolean => {
  try {
    valueOf.call(v as never);
    return true;
  } catch {
    return false;
  }
};

const enter = (stack: Set<object>, v: object): void => {
  if (stack.has(v)) throw new TypeError('Converting circular structure to JSON');
  stack.add(v);
};

const allowed = (cs: Cursors): boolean => cs.every((c) => c.value);

// undefined when some reading denies the key and everything below it.
const stepKey = (cs: Cursors, key: string): Cursors | undefined => {
  const next = new Map<string, Cursor>();
  const add = (c: Cursor) => next.set(`${+c.value}:${c.nodes.map((n) => n.id).join(',')}`, c);
  for (const c of cs) {
    add(step(c, key));
    if (key.includes('.')) add(key.split('.').reduce((d, seg) => step(d, seg), c));
  }

  const out: Cursor[] = [];
  for (const c of next.values()) {
    if (c.nodes.length > 0) out.push(c);
    else if (!c.value) return undefined;
  }
  return out.length > 0 ? out : [...next.values()].slice(0, 1);
};

const filterRecord = (obj: object, cs: Cursors, stack: Set<object>): Record<string, unknown> => {
  enter(stack, obj);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === '__proto__') continue;
    const next = stepKey(cs, key);
    if (next === undefined) continue;
    const json = toJson((obj as Record<string, unknown>)[key], key);
    if (json === undefined) continue;
    const value = filterValue(json, next, stack);
    if (value !== DROP) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  stack.delete(obj);
  return out;
};

// json is already what toJson returned.
const filterValue = (json: unknown, cs: Cursors, stack: Set<object>): unknown => {
  if (json === null || typeof json !== 'object') return allowed(cs) ? json : DROP;
  if (Array.isArray(json)) {
    const { out, any } = filterArray(json, cs, stack);
    return allowed(cs) || any ? out : DROP;
  }
  const out = filterRecord(json, cs, stack);
  return allowed(cs) || Object.keys(out).length > 0 ? out : DROP;
};

// Object and array elements stay, possibly empty; scalars the path denies
// are dropped. any reports whether something below the array path survived.
const filterArray = (arr: readonly unknown[], cs: Cursors, stack: Set<object>): { readonly out: unknown[]; readonly any: boolean } => {
  enter(stack, arr);
  const out: unknown[] = [];
  let any = false;
  for (let i = 0; i < arr.length; i++) {
    const json = toJson(arr[i], String(i)) ?? null;
    if (json === null || typeof json !== 'object') {
      if (allowed(cs)) {
        any = true;
        out.push(json);
      }
    } else if (Array.isArray(json)) {
      const a = filterArray(json, cs, stack);
      any ||= a.any;
      out.push(a.out);
    } else {
      const o = filterRecord(json, cs, stack);
      any ||= Object.keys(o).length > 0;
      out.push(o);
    }
  }
  stack.delete(arr);
  return { out, any };
};
