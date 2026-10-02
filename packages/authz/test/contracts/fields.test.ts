import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import * as root from '../../src/index.js';
import { AuthzConfigError } from '../../src/contracts/errors.js';
import { compileFieldGlobs, filterObject, isFieldGlob, normalizeFieldGlobs, subtractFieldGlobs, unionFieldGlobs } from '../../src/contracts/fields.js';
import type { FieldMatcher } from '../../src/index.js';

const expect = chai.expect;

// Reference implementation of the rule, written straight from the spec:
// the most specific matching glob wins, no match denies.
const oracle = (globs: readonly string[], path: readonly string[]): boolean => {
  let best: { segs: string[]; neg: boolean } | undefined;
  for (const glob of globs) {
    const neg = glob.startsWith('!');
    const segs = (neg ? glob.slice(1) : glob).split('.');
    if (segs.length > path.length || !segs.every((s, i) => s === '*' || s === path[i])) continue;
    if (best === undefined || moreSpecific({ segs, neg }, best)) best = { segs, neg };
  }
  return best !== undefined && !best.neg;
};

const moreSpecific = (g: { segs: string[]; neg: boolean }, than: { segs: string[]; neg: boolean }): boolean => {
  if (g.segs.length !== than.segs.length) return g.segs.length > than.segs.length;
  for (let i = 0; i < g.segs.length; i++) {
    const gStar = g.segs[i] === '*';
    if (gStar !== (than.segs[i] === '*')) return !gStar;
  }
  return g.neg && !than.neg;
};

const allows = (globs: readonly string[], path: string) => compileFieldGlobs(globs).allows(path);

const globArb = fc.tuple(fc.boolean(), fc.array(fc.constantFrom('a', 'b', '*'), { minLength: 1, maxLength: 3 })).map(([neg, segs]) => (neg ? '!' : '') + segs.join('.'));
const listArb = fc.array(globArb, { maxLength: 5 });
// 'c' appears in no glob, so it reaches the decision only through '*'.
const pathArb = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 4 });
const pathsArb = fc.array(pathArb, { minLength: 1, maxLength: 20 });

const ALL_PATHS: string[][] = [];
for (let n = 1; n <= 4; n++) {
  const walk = (prefix: string[]) => {
    if (prefix.length === n) {
      ALL_PATHS.push(prefix);
      return;
    }
    for (const s of ['a', 'b', 'c']) walk([...prefix, s]);
  };
  walk([]);
}

const sameMeaning = (x: readonly string[], y: readonly string[]) => ALL_PATHS.every((p) => oracle(x, p) === oracle(y, p));

const deepFreeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

describe('field glob contracts', () => {
  it('is exported from the package root', () => {
    expect(root.isFieldGlob).to.eq(isFieldGlob);
    expect(root.compileFieldGlobs).to.eq(compileFieldGlobs);
    expect(root.normalizeFieldGlobs).to.eq(normalizeFieldGlobs);
    expect(root.unionFieldGlobs).to.eq(unionFieldGlobs);
    expect(root.subtractFieldGlobs).to.eq(subtractFieldGlobs);
    expect(root.filterObject).to.eq(filterObject);

    const matcher: FieldMatcher = compileFieldGlobs(['*']);
    expect(matcher.allows('a')).to.eq(true);
  });

  describe('grammar', () => {
    const VALID = ['*', 'a', '!a', '!*', 'a.b', 'a.*', '*.b', '*.*', '!*.b.*', 'Password', 'user_name', 'a-b', 'a:b', 'ą1', '$x', 'a/b'];
    const INVALID = ['', '.a', 'a.', 'a..b', '**', 'a.**', 'a*', '*a', 'a*b', '!', '!!a', 'a!', 'a.!b', 'a b', ' a', 'a ', 'a\tb', 'a\n', '!.a', '*.', '.'];

    it('accepts valid globs', () => {
      for (const glob of VALID) {
        expect(isFieldGlob(glob), glob).to.eq(true);
        expect(() => compileFieldGlobs([glob]), glob).to.not.throw();
      }
    });

    it('rejects invalid globs with AuthzConfigError everywhere', () => {
      for (const glob of INVALID) {
        const label = JSON.stringify(glob);
        expect(isFieldGlob(glob), label).to.eq(false);
        expect(() => compileFieldGlobs(['*', glob]), label).to.throw(AuthzConfigError);
        expect(() => normalizeFieldGlobs([glob]), label).to.throw(AuthzConfigError);
        expect(() => unionFieldGlobs(['*'], [glob]), label).to.throw(AuthzConfigError);
        expect(() => subtractFieldGlobs(['*'], [glob]), label).to.throw(AuthzConfigError);
        expect(() => subtractFieldGlobs([glob], ['*']), label).to.throw(AuthzConfigError);
        expect(() => filterObject([glob], { a: 1 }), label).to.throw(AuthzConfigError);
      }
    });

    it('names the bad glob in the error', () => {
      expect(() => compileFieldGlobs(['a..b'])).to.throw(AuthzConfigError, '"a..b"');
    });

    it('rejects non-strings', () => {
      for (const value of [undefined, null, 1, true, {}, [], ['a'], new String('a'), Symbol('a')]) {
        expect(isFieldGlob(value), String(value)).to.eq(false);
        expect(() => compileFieldGlobs([value as unknown as string]), String(value)).to.throw(AuthzConfigError);
      }
    });
  });

  describe('specificity', () => {
    it("['*', '!Password'] allows everything but Password and its subtree", () => {
      const m = compileFieldGlobs(['*', '!Password']);
      expect(m.allows('Id')).to.eq(true);
      expect(m.allows('Profile.Bio')).to.eq(true);
      expect(m.allows('Password')).to.eq(false);
      expect(m.allows('Password.hash')).to.eq(false);
      expect(m.allows(['Password'])).to.eq(false);
      expect(m.allows('PasswordX')).to.eq(true);
    });

    it('decides the notation README list', () => {
      const globs = ['*', '!id', 'name', 'car.model', '!car.*', 'id', 'name', 'age'];
      const m = compileFieldGlobs(globs);
      expect(m.allows('id')).to.eq(false); // equal specificity: the negation wins
      expect(m.allows('name')).to.eq(true);
      expect(m.allows('age')).to.eq(true);
      expect(m.allows('car')).to.eq(true);
      expect(m.allows('car.model')).to.eq(true);
      expect(m.allows('car.model.year')).to.eq(true);
      expect(m.allows('car.brand')).to.eq(false);
      expect(m.allows('car.brand.x')).to.eq(false);
      expect(m.allows('other.x')).to.eq(true);
    });

    it("['*', '!car.*', 'car.model'] allows car.model but no other child of car", () => {
      const m = compileFieldGlobs(['*', '!car.*', 'car.model']);
      expect(m.allows('car.model')).to.eq(true);
      expect(m.allows('car.brand')).to.eq(false);
      expect(m.allows('car')).to.eq(true);
    });

    it('a literal beats a star at the first position where they differ', () => {
      expect(allows(['a.*', '!*.b'], 'a.b')).to.eq(true);
      expect(allows(['!a.*', '*.b'], 'a.b')).to.eq(false);
      expect(allows(['a.*', '!*.b'], 'x.b')).to.eq(false);
      expect(allows(['a.*', '!*.b'], 'a.c')).to.eq(true);
    });

    it('more segments win', () => {
      expect(allows(['!a', '*.*.c'], 'a.b.c')).to.eq(true);
      expect(allows(['!a', '*.*.c'], 'a.b')).to.eq(false);
      expect(allows(['a', '!*.b'], 'a.b')).to.eq(false);
    });

    it('a glob covers its whole subtree and needs at least its own depth', () => {
      expect(allows(['a.*'], 'a')).to.eq(false);
      expect(allows(['a.*'], 'a.b')).to.eq(true);
      expect(allows(['a.*'], 'a.b.c.d')).to.eq(true);
      expect(allows(['a.b'], 'a')).to.eq(false);
      expect(allows(['*'], 'x.y.z')).to.eq(true);
    });

    it('equal specificity: the negation wins, in any order', () => {
      expect(allows(['a', '!a'], 'a')).to.eq(false);
      expect(allows(['!a', 'a'], 'a')).to.eq(false);
      expect(allows(['*.b', '!*.b'], 'x.b')).to.eq(false);
    });

    it('an empty list allows nothing', () => {
      const m = compileFieldGlobs([]);
      expect(m.allows('a')).to.eq(false);
      expect(m.allows('a.b')).to.eq(false);
    });

    it('no path segments means no match', () => {
      expect(allows(['*'], '')).to.eq(false);
      expect(compileFieldGlobs(['*']).allows([])).to.eq(false);
    });

    it('path segments are field names: array form keeps dots inside a key', () => {
      const m = compileFieldGlobs(['*', '!a.b']);
      expect(m.allows(['a.b'])).to.eq(true);
      expect(m.allows(['a', 'b'])).to.eq(false);
      expect(m.allows('a.b')).to.eq(false);
      expect(compileFieldGlobs(['a.*']).allows(['a', 'x.y'])).to.eq(true);
    });

    it('agrees with the reference rule on random lists and paths', () => {
      fc.assert(
        fc.property(listArb, pathsArb, (globs, paths) => {
          const m = compileFieldGlobs(globs);
          for (const p of paths) {
            if (m.allows(p) !== oracle(globs, p)) return false;
            if (m.allows(p.join('.')) !== oracle(globs, p)) return false;
          }
          return true;
        }),
        { numRuns: 500 },
      );
    });
  });

  describe('normalize', () => {
    it('normalizes the notation README list to the same result', () => {
      expect(normalizeFieldGlobs(['*', '!id', 'name', 'car.model', '!car.*', 'id', 'name', 'age'])).to.deep.eq(['*', '!id', '!car.*', 'car.model']);
    });

    it('fixed cases', () => {
      expect(normalizeFieldGlobs([])).to.deep.eq([]);
      expect(normalizeFieldGlobs(['!*'])).to.deep.eq([]);
      expect(normalizeFieldGlobs(['*', '*.*', 'a'])).to.deep.eq(['*']);
      expect(normalizeFieldGlobs(['!Password', '*'])).to.deep.eq(['*', '!Password']);
      expect(normalizeFieldGlobs(['a.*', '!*.b'])).to.deep.eq(['a.*']);
      expect(normalizeFieldGlobs(['b', 'a'])).to.deep.eq(['a', 'b']);
      expect(normalizeFieldGlobs(['a.b', 'a.*'])).to.deep.eq(['a.*']);
    });

    it('returns a new array and leaves the input alone', () => {
      const input = Object.freeze(['*', '*']);
      const out = normalizeFieldGlobs(input);
      expect(out).to.not.eq(input);
      expect(input).to.deep.eq(['*', '*']);
    });

    it('preserves meaning, is idempotent and canonical (property)', () => {
      fc.assert(
        fc.property(listArb, pathsArb, (globs, paths) => {
          const n = normalizeFieldGlobs(globs);
          if (!n.every(isFieldGlob)) return false;
          if (!paths.every((p) => oracle(n, p) === oracle(globs, p))) return false;
          if (!sameMeaning(n, globs)) return false;
          const again = normalizeFieldGlobs(n);
          const shuffled = normalizeFieldGlobs([...globs].reverse().concat(globs));
          return JSON.stringify(again) === JSON.stringify(n) && JSON.stringify(shuffled) === JSON.stringify(n);
        }),
        { numRuns: 300 },
      );
    });

    it('has no redundant glob (property)', () => {
      fc.assert(
        fc.property(listArb, (globs) => {
          const n = normalizeFieldGlobs(globs);
          return n.every(
            (_, i) =>
              !sameMeaning(
                n.filter((__, j) => j !== i),
                n,
              ),
          );
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('union and subtract', () => {
    it('unites the notation README example (exact union)', () => {
      const a = ['*', '!car.model', 'car.brand', '!*.age'];
      const b = ['car.model', 'user.age', 'user.name'];
      const u = unionFieldGlobs(a, b);
      // notation gives ['*', '!*.age', 'user.age']: the same meaning
      expect(u).to.deep.eq(['*', '!*.age', 'user.*']);
      expect(sameMeaning(u, ['*', '!*.age', 'user.age'])).to.eq(true);
      for (const p of [...ALL_PATHS, ['car', 'model'], ['car', 'model', 'x'], ['car', 'age'], ['user', 'age'], ['car', 'brand']]) {
        expect(oracle(u, p), p.join('.')).to.eq(oracle(a, p) || oracle(b, p));
      }
    });

    it('fixed union cases', () => {
      // notation gives ['a.*', '!a.b'], which denies a.b although the first list allows it
      expect(unionFieldGlobs(['a.*', '!*.b'], ['!a.b'])).to.deep.eq(['a.*']);
      expect(unionFieldGlobs(['!a'], ['*'])).to.deep.eq(['*']);
      expect(unionFieldGlobs(['*', '!a'], ['a.b'])).to.deep.eq(['*', '!a', 'a.b']);
      expect(unionFieldGlobs(['a'], ['b'], ['c.d'])).to.deep.eq(['a', 'b', 'c.d']);
      expect(unionFieldGlobs([], [])).to.deep.eq([]);
      expect(unionFieldGlobs()).to.deep.eq([]);
      expect(unionFieldGlobs(['b', 'a'])).to.deep.eq(['a', 'b']);
    });

    it('needs a glob none of the inputs has', () => {
      // allowed unless the first key is not 'a' and the second is 'b'
      const u = unionFieldGlobs(['a.*'], ['*', '!*.b']);
      expect(u).to.deep.eq(['*', '!*.b', 'a.*']);
      for (const p of ALL_PATHS) expect(oracle(u, p), p.join('.')).to.eq(oracle(['a.*'], p) || oracle(['*', '!*.b'], p));
    });

    it('fixed subtract cases', () => {
      expect(subtractFieldGlobs(['*'], ['Password'])).to.deep.eq(['*', '!Password']);
      expect(subtractFieldGlobs(['*', '!Password'], ['*'])).to.deep.eq([]);
      expect(subtractFieldGlobs(['user.*'], ['*.secret'])).to.deep.eq(['user.*', '!user.secret']);
      expect(subtractFieldGlobs(['a.*', '!*.b'], ['a.c'])).to.deep.eq(['a.*', '!a.c']);
      expect(subtractFieldGlobs(['*'], [])).to.deep.eq(['*']);
      expect(subtractFieldGlobs([], ['*'])).to.deep.eq([]);
      expect(subtractFieldGlobs(['*', '!car.*', 'car.model'], ['!*'])).to.deep.eq(['*', '!car.*', 'car.model']);
    });

    it('union is exact and normalized (property)', () => {
      fc.assert(
        fc.property(listArb, listArb, listArb, pathsArb, (a, b, c, paths) => {
          const u = unionFieldGlobs(a, b);
          const u3 = unionFieldGlobs(a, b, c);
          const ok = (p: string[]) => oracle(u, p) === (oracle(a, p) || oracle(b, p)) && oracle(u3, p) === (oracle(a, p) || oracle(b, p) || oracle(c, p));
          return paths.every(ok) && ALL_PATHS.every(ok) && JSON.stringify(normalizeFieldGlobs(u)) === JSON.stringify(u) && JSON.stringify(unionFieldGlobs(b, a)) === JSON.stringify(u);
        }),
        { numRuns: 300 },
      );
    });

    it('subtract is exact and normalized (property)', () => {
      fc.assert(
        fc.property(listArb, listArb, pathsArb, (a, b, paths) => {
          const s = subtractFieldGlobs(a, b);
          const ok = (p: string[]) => oracle(s, p) === (oracle(a, p) && !oracle(b, p));
          return paths.every(ok) && ALL_PATHS.every(ok) && JSON.stringify(normalizeFieldGlobs(s)) === JSON.stringify(s);
        }),
        { numRuns: 300 },
      );
    });

    it('stays fast on lists whose naive product is exponential', () => {
      // 'k' at exactly one of 14 positions: 2^14 sets of matching globs
      const depth = 14;
      const globs = Array.from({ length: depth }, (_, i) => Array.from({ length: depth }, (__, j) => (i === j ? 'k' : '*')).join('.'));
      const negs = globs.map((g) => '!' + g.replace('k', 'n'));
      const started = Date.now();
      const u = unionFieldGlobs(globs, negs);
      const s = subtractFieldGlobs(globs, ['*.' + globs[1]]);
      const n = normalizeFieldGlobs([...globs, ...negs]);
      expect(Date.now() - started).to.be.lessThan(5000);
      const path = Array.from({ length: depth }, (_, i) => (i === 3 ? 'k' : i === 1 ? 'n' : 'x'));
      expect(oracle(u, path)).to.eq(oracle(globs, path) || oracle(negs, path));
      expect(oracle(n, path)).to.eq(oracle([...globs, ...negs], path));
      expect(oracle(s, path)).to.eq(oracle(globs, path));
    });

    it('handles tens of realistic globs quickly', () => {
      const fields = ['Id', 'Name', 'Email', 'Password', 'Profile', 'Settings', 'Org', 'Projects', 'Tokens', 'Meta'];
      const a = ['*', '!Password', '!*.secret', '!Tokens.*', 'Tokens.Name', ...fields.slice(0, 6).map((f) => `${f}.public.*`)];
      const b = [...fields.map((f) => `${f}.*`), '!Meta.internal.*', 'Meta.internal.version', '!*.*.hash', 'Org.Billing.Plan', '!Org.Billing.*'];
      const hide = ['Password', '*.secret.*', 'Profile.Address.Street', 'Org.Billing.Card.*'];
      const started = Date.now();
      const read = subtractFieldGlobs(unionFieldGlobs(a, b), hide);
      expect(Date.now() - started).to.be.lessThan(2000);
      const probes = ['Id', 'Password', 'Password.x', 'Profile.secret', 'Profile.secret.x', 'Profile.Address.Street', 'Tokens.Name', 'Tokens.Value', 'Meta.internal.version', 'Meta.internal.other', 'Org.Billing.Plan', 'Org.Billing.Card.Number', 'Settings.a.hash', 'Unknown.x.y'];
      for (const p of probes) {
        const path = p.split('.');
        expect(oracle(read, path), p).to.eq((oracle(a, path) || oracle(b, path)) && !oracle(hide, path));
      }
    });
  });

  describe('filterObject', () => {
    it('filters nested objects', () => {
      const data = { id: 1, car: { brand: 'Ford', model: 'Mustang' }, dog: { breed: 'Akita' } };
      expect(filterObject(['*', '!car.*', 'car.model'], data)).to.deep.eq({ id: 1, car: { model: 'Mustang' }, dog: { breed: 'Akita' } });
      expect(filterObject(['*', '!car'], data)).to.deep.eq({ id: 1, dog: { breed: 'Akita' } });
      expect(filterObject(['car.model'], data)).to.deep.eq({ car: { model: 'Mustang' } });
      expect(filterObject(['a.*', '!*.b'], { a: { b: 1, c: 2 }, x: { b: 3 } })).to.deep.eq({ a: { b: 1, c: 2 } });
    });

    it('keeps an object key when the key is allowed even if nothing below is', () => {
      expect(filterObject(['car', '!car.*'], { car: { brand: 'Ford' } })).to.deep.eq({ car: {} });
      expect(filterObject(['car.model'], { car: { brand: 'Ford' } })).to.deep.eq({});
    });

    it('a deeper glob does not keep a shallower leaf', () => {
      // notation keeps { a: 'x' } here
      expect(filterObject(['a.*'], { a: 'x', b: 1 })).to.deep.eq({});
    });

    it('filters arrays of objects element-wise with the same path', () => {
      const data = { items: [{ name: 'a', price: 1 }, { price: 2 }], total: 3 };
      expect(filterObject(['items.name'], data)).to.deep.eq({ items: [{ name: 'a' }, {}] });
      expect(filterObject(['*', '!items.price'], data)).to.deep.eq({ items: [{ name: 'a' }, {}], total: 3 });
      expect(filterObject(['total'], data)).to.deep.eq({ total: 3 });
    });

    it('filters arrays of scalars by the array path', () => {
      const data = { tags: ['a', 'b'], x: 1 };
      expect(filterObject(['tags'], data)).to.deep.eq({ tags: ['a', 'b'] });
      expect(filterObject(['x'], data)).to.deep.eq({ x: 1 });
      expect(filterObject(['*', '!tags'], data)).to.deep.eq({ x: 1 });
      expect(filterObject(['tags.*'], data)).to.deep.eq({});
    });

    it('mixed arrays: objects filtered, scalars kept only when the path is allowed', () => {
      expect(filterObject(['list.a'], { list: [{ a: 1, b: 2 }, 5, [{ a: 3, b: 4 }, 6]] })).to.deep.eq({ list: [{ a: 1 }, [{ a: 3 }]] });
      expect(filterObject(['list'], { list: [{ a: 1 }, 5] })).to.deep.eq({ list: [{ a: 1 }, 5] });
    });

    it('maps a top-level array', () => {
      const rows = [{ name: 'a', age: 1 }, { age: 2 }];
      const out: Partial<{ name: string; age: number }>[] = filterObject(['name'], rows);
      expect(out).to.deep.eq([{ name: 'a' }, {}]);
      expect(filterObject(['*'], [])).to.deep.eq([]);
    });

    it('treats Date and other class instances as leaves', () => {
      const created = new Date(0);
      class Point {
        x = 1;
      }
      const at = new Point();
      const out = filterObject(['created', 'at'], { created, at, other: 1 });
      expect(out).to.deep.eq({ created, at });
      expect(out.created).to.eq(created);
      expect(out.at).to.eq(at);
      expect(filterObject(['created.time', 'at.x'], { created, at })).to.deep.eq({});
    });

    it("applies ['*', '!Password'] to a user row", () => {
      const row = { Id: 1, Email: 'a@b.c', Password: 'hash', Profile: { Bio: 'x', Password: 'kept: only the top-level key is named' } };
      expect(filterObject(['*', '!Password'], row)).to.deep.eq({ Id: 1, Email: 'a@b.c', Profile: { Bio: 'x', Password: 'kept: only the top-level key is named' } });
      expect(filterObject(['*', '!Password', '!*.Password'], row)).to.deep.eq({ Id: 1, Email: 'a@b.c', Profile: { Bio: 'x' } });
    });

    it('returns new objects and never mutates the input', () => {
      const data = deepFreeze({ a: { b: 1, c: [{ d: 2 }] }, e: [1, 2] });
      const out = filterObject(['*'], data);
      expect(out).to.deep.eq(data);
      expect(out).to.not.eq(data);
      expect(out.a).to.not.eq(data.a);
      expect(out.a?.c).to.not.eq(data.a.c);
      expect(out.a?.c?.[0]).to.not.eq(data.a.c[0]);
      expect(out.e).to.not.eq(data.e);
      expect(filterObject(['a.b'], data)).to.deep.eq({ a: { b: 1 } });
    });

    it('copies only own enumerable string keys', () => {
      const proto = { inherited: 1 };
      const data = Object.create(proto) as Record<string | symbol, unknown>;
      data.own = 1;
      data[Symbol('s')] = 2;
      Object.defineProperty(data, 'hidden', { value: 3, enumerable: false });
      // a non-plain prototype makes this a leaf; check the plain case too
      expect(filterObject(['*'], { x: data })).to.deep.eq({ x: data });
      const plain: Record<string | symbol, unknown> = { own: 1, [Symbol('s')]: 2 };
      Object.defineProperty(plain, 'hidden', { value: 3, enumerable: false });
      const out = filterObject(['*'], plain);
      expect(Reflect.ownKeys(out)).to.deep.eq(['own']);
    });

    it('treats null-prototype objects as plain objects', () => {
      const data = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: 2 });
      expect(filterObject(['a'], data)).to.deep.eq({ a: 1 });
    });

    it('a __proto__ own key does not pollute', () => {
      const data = JSON.parse('{"__proto__": {"polluted": true}, "a": 1, "n": {"__proto__": {"polluted": true}}}') as Record<string, unknown>;
      const out = filterObject(['*'], data) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).to.eq(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).to.eq(true);
      expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).to.deep.eq({ polluted: true });
      expect(out.polluted).to.eq(undefined);
      const n = out.n as Record<string, unknown>;
      expect(Object.getPrototypeOf(n)).to.eq(Object.prototype);
      expect(n.polluted).to.eq(undefined);
      expect(({} as Record<string, unknown>).polluted).to.eq(undefined);
      expect(filterObject(['*', '!__proto__'], data)).to.deep.eq({ a: 1, n: JSON.parse('{"__proto__": {"polluted": true}}') });
    });

    it('returns a top-level leaf unchanged', () => {
      expect(filterObject(['*'], 5)).to.eq(5);
      expect(filterObject([], null)).to.eq(null);
    });

    it('an empty list keeps nothing', () => {
      expect(filterObject([], { a: 1, b: { c: 2 } })).to.deep.eq({});
    });

    it('agrees with the matcher on every leaf (property)', () => {
      const keyArb = fc.constantFrom('a', 'b', 'c');
      const objArb = fc.letrec((tie) => ({
        node: fc.dictionary(keyArb, fc.oneof({ depthSize: 'small', maxDepth: 3 }, fc.integer(), tie('node')), { maxKeys: 3 }),
      })).node;
      fc.assert(
        fc.property(listArb, objArb, (globs, data) => {
          const out = filterObject(globs, data);
          const check = (src: unknown, dst: unknown, path: string[]): boolean => {
            if (typeof src !== 'object' || src === null) return true;
            for (const [k, v] of Object.entries(src)) {
              const p = [...path, k];
              const has = typeof dst === 'object' && dst !== null && Object.prototype.hasOwnProperty.call(dst, k);
              const child = has ? (dst as Record<string, unknown>)[k] : undefined;
              if (typeof v !== 'object' || v === null) {
                if (has !== oracle(globs, p) || (has && child !== v)) return false;
              } else if (has !== (oracle(globs, p) || hasAllowedBelow(globs, v, p))) {
                return false;
              } else if (has && !check(v, child, p)) {
                return false;
              }
            }
            return true;
          };
          return check(data, out, []);
        }),
        { numRuns: 300 },
      );
    });
  });
});

const hasAllowedBelow = (globs: readonly string[], v: unknown, path: string[]): boolean => {
  if (typeof v !== 'object' || v === null) return oracle(globs, path);
  return Object.entries(v).some(([k, x]) => {
    const p = [...path, k];
    return oracle(globs, p) || (typeof x === 'object' && x !== null && hasAllowedBelow(globs, x, p));
  });
};
