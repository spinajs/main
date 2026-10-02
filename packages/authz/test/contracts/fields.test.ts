import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import vm from 'node:vm';

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
      for (const value of [undefined, null, 1, true, {}, [], ['a'], new String('a'), Symbol('a'), Object.create(null)]) {
        expect(isFieldGlob(value), typeof value).to.eq(false);
        expect(() => compileFieldGlobs([value as unknown as string]), typeof value).to.throw(AuthzConfigError);
        expect(() => normalizeFieldGlobs([value as unknown as string]), typeof value).to.throw(AuthzConfigError);
      }
    });

    it('rejects lists that are not arrays', () => {
      for (const list of ['*', undefined, null, { 0: '*', length: 1 }, new Set(['*'])]) {
        const bad = list as unknown as string[];
        expect(() => compileFieldGlobs(bad), typeof list).to.throw(AuthzConfigError);
        expect(() => normalizeFieldGlobs(bad), typeof list).to.throw(AuthzConfigError);
        expect(() => unionFieldGlobs(['a'], bad), typeof list).to.throw(AuthzConfigError);
        expect(() => subtractFieldGlobs(bad, ['a']), typeof list).to.throw(AuthzConfigError);
        expect(() => filterObject(bad, { a: 1 }), typeof list).to.throw(AuthzConfigError);
      }
    });

    it('cuts a long glob short in the error', () => {
      const long = 'a'.repeat(100_000) + '..b';
      try {
        compileFieldGlobs([long]);
        expect.fail('no throw');
      } catch (e) {
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect((e as Error).message.length).to.be.lessThan(400);
      }
    });

    it('caps globs per list and segments per glob', () => {
      expect(() => compileFieldGlobs(Array.from({ length: 1000 }, (_, i) => `f${i}`))).to.not.throw();
      expect(() => compileFieldGlobs(Array.from({ length: 1001 }, (_, i) => `f${i}`))).to.throw(AuthzConfigError);
      expect(() => compileFieldGlobs([Array(32).fill('a').join('.')])).to.not.throw();
      expect(() => compileFieldGlobs([Array(33).fill('a').join('.')])).to.throw(AuthzConfigError);
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

    it('handles lists whose naive product is exponential', function () {
      this.timeout(30_000);
      // 'k' at exactly one of 14 positions: 2^14 sets of matching globs
      const depth = 14;
      const globs = Array.from({ length: depth }, (_, i) => Array.from({ length: depth }, (__, j) => (i === j ? 'k' : '*')).join('.'));
      const negs = globs.map((g) => '!' + g.replace('k', 'n'));
      const started = Date.now();
      const u = unionFieldGlobs(globs, negs);
      const s = subtractFieldGlobs(globs, ['*.' + globs[1]]);
      const n = normalizeFieldGlobs([...globs, ...negs]);
      expect(Date.now() - started).to.be.lessThan(10_000);
      const path = Array.from({ length: depth }, (_, i) => (i === 3 ? 'k' : i === 1 ? 'n' : 'x'));
      expect(oracle(u, path)).to.eq(oracle(globs, path) || oracle(negs, path));
      expect(oracle(n, path)).to.eq(oracle([...globs, ...negs], path));
      expect(oracle(s, path)).to.eq(oracle(globs, path));
    });

    describe('hostile lists give the exact result or throw AuthzConfigError', function () {
      this.timeout(30_000);
      const star = (n: number) => Array<string>(n).fill('*');
      const shapes: Array<[string, string[]]> = [];
      // 'k' at position i of a glob of length n + i: no trie node covers another
      shapes.push(['distinct lengths', Array.from({ length: 16 }, (_, i) => [...star(i), 'k', ...star(15)].join('.'))]);
      shapes.push(['distinct lengths, signs', ['*', ...Array.from({ length: 16 }, (_, i) => (i % 2 ? '' : '!') + [...star(i), 'k', ...star(15)].join('.'))]]);
      shapes.push(['same length', Array.from({ length: 16 }, (_, i) => [...star(i), 'k', ...star(15 - i)].join('.'))]);
      const grid = ['*'];
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 10; j++) {
          const len = i + 1 + ((i + j) % (5 - i));
          grid.push(((i + j) % 2 ? '!' : '') + [...star(i), `x${j}`, ...star(len - i - 1)].join('.'));
        }
      }
      shapes.push(['names at every position, depth 5', grid]);
      shapes.push(['wide', ['*', ...Array.from({ length: 999 }, (_, i) => `!f${i}`)]]);
      shapes.push(['wide and deep', ['*', ...Array.from({ length: 200 }, (_, i) => `!*.f${i}.*.g`)]]);
      shapes.push(['two names at nine positions', Array.from({ length: 9 }, (_, i) => ['a', 'b'].map((nm) => ((i + nm.length) % 2 ? '!' : '') + [...star(i), nm, ...star(3)].join('.'))).flat()]);
      shapes.push(['deep literal', ['*', '!' + Array.from({ length: 32 }, (_, i) => `s${i}`).join('.')]]);
      shapes.push(['deep star', ['!' + star(32).join('.'), '*']]);

      // Paths over the literals the globs name plus one they do not, from a
      // fixed seed so a run is repeatable.
      const probes = (lists: readonly (readonly string[])[]): string[][] => {
        const names = new Set<string>(['zz']);
        let depth = 1;
        for (const l of lists) {
          for (const g of l) {
            const segs = g.replace(/^!/, '').split('.');
            depth = Math.max(depth, segs.length + 1);
            for (const x of segs) if (x !== '*') names.add(x);
          }
        }
        const pool = [...names];
        let seed = 7;
        const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
        return Array.from({ length: 300 }, () => Array.from({ length: 1 + rnd(depth) }, () => pool[rnd(pool.length)]));
      };

      const outcome = (label: string, run: () => string[], expected: (p: readonly string[]) => boolean, paths: readonly string[][]) => {
        const started = Date.now();
        let out: string[] | undefined;
        try {
          out = run();
        } catch (e) {
          expect(e, label).to.be.instanceOf(AuthzConfigError);
          expect((e as Error).message, label).to.match(/too complex|Too many|segments/);
        }
        expect(Date.now() - started, label).to.be.lessThan(10_000);
        if (out !== undefined) {
          for (const p of paths) expect(oracle(out, p), `${label} ${p.join('.')}`).to.eq(expected(p));
        }
      };

      const extra = ['!*.*.x0', 'x1.*'];
      for (const [name, globs] of shapes) {
        it(name, () => {
          const paths = probes([globs, extra]);
          outcome(
            'normalize',
            () => normalizeFieldGlobs(globs),
            (p) => oracle(globs, p),
            paths,
          );
          outcome(
            'union',
            () => unionFieldGlobs(globs, extra),
            (p) => oracle(globs, p) || oracle(extra, p),
            paths,
          );
          outcome(
            'subtract',
            () => subtractFieldGlobs(['*'], globs),
            (p) => !oracle(globs, p),
            paths,
          );
        });
      }

      it('the work limit is an AuthzConfigError', () => {
        const globs = Array.from({ length: 20 }, (_, i) => [...star(i), 'k', ...star(12)].join('.'));
        expect(() => normalizeFieldGlobs(globs)).to.throw(AuthzConfigError, 'too complex');
      });
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

    describe('JSON semantics', () => {
      const F = ['*', '!Password', '!*.Password'];

      it('Date, Buffer, typed arrays and ArrayBuffer read as JSON.stringify reads them', () => {
        const created = new Date(0);
        const out = filterObject(F, { created, buf: Buffer.from('ab'), bytes: new Uint8Array([1]), raw: new ArrayBuffer(2) });
        expect(out).to.deep.eq({ created: '1970-01-01T00:00:00.000Z', buf: { type: 'Buffer', data: [97, 98] }, bytes: { '0': 1 }, raw: {} });
        expect(filterObject(['created.time'], { created })).to.deep.eq({});
        expect(filterObject(['*'], created)).to.eq('1970-01-01T00:00:00.000Z');
      });

      it('calls toJSON with the key and filters what it returns', () => {
        const keyed = { toJSON: (k: string) => `key:${k}` };
        expect(filterObject(['*'], { a: keyed, list: [keyed] })).to.deep.eq({ a: 'key:a', list: ['key:0'] });
        expect(filterObject(['*'], keyed)).to.eq('key:');
        const raw = { Password: 'h', Id: 1 };
        expect(filterObject(F, { Id: 2, Password: 'x', toJSON: () => raw })).to.deep.eq({ Id: 1 });
        expect(filterObject(F, { Owner: { toJSON: () => raw } })).to.deep.eq({ Owner: { Id: 1 } });
      });

      it('drops functions, symbols and undefined from records and writes null in arrays', () => {
        const out = filterObject(F, { Id: 1, f: function named() {}, s: Symbol('x'), u: undefined, list: [1, () => 2, Symbol('y'), undefined] });
        expect(out).to.deep.eq({ Id: 1, list: [1, null, null, null] });
        expect(filterObject(['*'], () => 1)).to.eq(undefined);
        expect(filterObject(['*'], [() => 1, 2])).to.deep.eq([null, 2]);
        expect(filterObject(['list.a'], { list: [() => 1, { a: 1 }] })).to.deep.eq({ list: [{ a: 1 }] });
      });

      it('unwraps boxed primitives and throws on bigint, as JSON does', () => {
        expect(filterObject(['*'], { n: new Number(1), s: new String('x'), b: new Boolean(false) })).to.deep.eq({ n: 1, s: 'x', b: false });
        expect(() => filterObject(['*'], { n: BigInt(1) })).to.throw(TypeError);
        expect(() => filterObject(['*'], { n: Object(BigInt(1)) })).to.throw(TypeError);
      });

      it('throws TypeError on a cycle it reaches', () => {
        const a: Record<string, unknown> = { Id: 1 };
        a.self = a;
        expect(() => filterObject(['*'], a)).to.throw(TypeError, 'circular');
        const list: unknown[] = [];
        list.push(list);
        expect(() => filterObject(['*'], { list })).to.throw(TypeError, 'circular');
        // a denied key is never read
        expect(filterObject(['Id'], a)).to.deep.eq({ Id: 1 });
        // the same object twice, not nested, is no cycle
        const shared = { x: 1 };
        expect(filterObject(['*'], { a: shared, b: [shared, shared] })).to.deep.eq({ a: { x: 1 }, b: [{ x: 1 }, { x: 1 }] });
      });

      it('a fake Date fails closed', () => {
        const fake = Object.create(Date.prototype) as Record<string, unknown>;
        fake.Password = 'h';
        expect(() => filterObject(['*'], { created: fake })).to.throw(TypeError);
      });

      it('class instances without toJSON, objects from another realm, Map and Set are records', () => {
        class Point {
          x = 1;
          get y() {
            return 2;
          }
        }
        expect(filterObject(['at'], { at: new Point() })).to.deep.eq({ at: { x: 1 } });
        expect(filterObject(['at', '!at.*'], { at: new Point() })).to.deep.eq({ at: {} });
        expect(Object.getPrototypeOf(filterObject(['*'], new Point()))).to.eq(Object.prototype);
        const row = vm.runInNewContext('({ Id: 1, Password: "h", Owner: { Password: "h", Name: "n" }, created: new Date(0) })') as object;
        expect(JSON.stringify(filterObject(F, row))).to.eq('{"Id":1,"Owner":{"Name":"n"},"created":"1970-01-01T00:00:00.000Z"}');
        expect(filterObject(F, { m: new Map([['Password', 'h']]), s: new Set(['h']) })).to.deep.eq({ m: {}, s: {} });
      });

      it('returns plain arrays for array subclasses', () => {
        class Coll<T> extends Array<T> {}
        const top = Coll.from([{ Id: 1, Password: 'h' }]);
        const outTop = filterObject(F, top);
        expect(Object.getPrototypeOf(outTop)).to.eq(Array.prototype);
        expect(JSON.stringify(outTop)).to.eq('[{"Id":1}]');
        const nested = filterObject(F, { list: Coll.from([1, 2]) });
        expect(Object.getPrototypeOf(nested.list)).to.eq(Array.prototype);
        expect(JSON.stringify(nested)).to.eq('{"list":[1,2]}');
      });

      // Same shape as an @spinajs/orm model: a relation object pointing back
      // at its owner, internal own fields, a Luxon-like timestamp, and toJSON
      // returning dehydrated columns. The real ModelBase needs DI and a
      // driver, and authz does not depend on orm.
      class DateTimeLike {
        ts = 0;
        _zone = {};
        loc = { locale: 'pl-PL' };
        toJSON() {
          return '2026-10-02T12:00:00.000+02:00';
        }
      }
      class RelationLike {
        Populated = false;
        constructor(public _owner: ModelLike, public Value?: ModelLike) {}
      }
      class ModelLike {
        _container = { config: { db: { password: 'p' } } };
        __snapshot__ = { Columns: { Password: 'h' } };
        Password = 'h';
        CreatedAt = new DateTimeLike();
        Owner: RelationLike;
        constructor(public Id: number, owner?: ModelLike) {
          this.Owner = new RelationLike(this, owner);
        }
        dehydrate(): Record<string, unknown> {
          const data: Record<string, unknown> = { Id: this.Id, Password: this.Password, CreatedAt: this.CreatedAt };
          if (this.Owner.Value) data.Owner = this.Owner.Value.dehydrate();
          return data;
        }
        toJSON() {
          return this.dehydrate();
        }
      }

      it('model-shaped objects serialise through toJSON without internals or overflow', () => {
        const model = new ModelLike(2, new ModelLike(1));
        const expected = { Id: 2, CreatedAt: '2026-10-02T12:00:00.000+02:00', Owner: { Id: 1, CreatedAt: '2026-10-02T12:00:00.000+02:00' } };
        expect(filterObject(F, model)).to.deep.eq(expected);
        expect(filterObject(F, [model])).to.deep.eq([expected]);
        // rows.Owner.Password is three segments deep: F alone keeps it
        expect(filterObject([...F, '!*.*.Password'], { rows: [model] })).to.deep.eq({ rows: [expected] });
        expect(JSON.stringify(filterObject(['*'], model))).to.not.match(/_container|__snapshot__|_owner|password/);
        expect(filterObject(F, { CreatedAt: new DateTimeLike() })).to.deep.eq({ CreatedAt: '2026-10-02T12:00:00.000+02:00' });
      });

      it('equals filtering the JSON round trip (property)', () => {
        const keyArb = fc.constantFrom('a', 'b', 'c', 'a.b', 'Password');
        const leafArb = fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constantFrom('x', 'y'),
          fc.date({ noInvalidDate: true }),
          fc.constant(undefined),
          fc.constant(() => 1),
          fc.constant(Number.NaN),
        );
        const valueArb = fc.letrec((tie) => ({
          value: fc.oneof({ depthSize: 'small', maxDepth: 3 }, leafArb, tie('record'), tie('array'), tie('wrapped')),
          record: fc.dictionary(keyArb, tie('value'), { maxKeys: 4 }),
          array: fc.array(tie('value'), { maxLength: 3 }),
          wrapped: tie('value').map((inner) => ({ hidden: 'x', toJSON: () => inner })),
        })).value;
        fc.assert(
          fc.property(listArb, valueArb, (globs, x) => {
            const text = JSON.stringify(x);
            const direct = JSON.stringify(filterObject(globs, x));
            const roundTrip = JSON.stringify(filterObject(globs, text === undefined ? undefined : JSON.parse(text)));
            return direct === roundTrip;
          }),
          { numRuns: 500 },
        );
      });
    });

    describe('keys that contain a dot', () => {
      const F = ['*', '!Password', '!*.Password'];

      it('need both readings to allow them', () => {
        expect(filterObject(F, { 'Owner.Password': 'h', Id: 1 })).to.deep.eq({ Id: 1 });
        expect(filterObject(F, { 'Owner.Name': 'n' })).to.deep.eq({ 'Owner.Name': 'n' });
        // only the one-segment reading is allowed
        expect(filterObject(['Owner', 'a.b'], { 'Owner.Name': 'n', 'a.b': 1 })).to.deep.eq({});
        // only the dotted reading is allowed
        expect(filterObject(['a.b'], { 'a.b': 1 })).to.deep.eq({});
        expect(filterObject(['*', '!a.b'], { 'a.b': 1, a: { b: 2, c: 3 } })).to.deep.eq({ a: { c: 3 } });
      });

      it('carry both readings to the keys below them', () => {
        expect(filterObject(F, { 'a.Owner': { Password: 'h', Name: 'n' } })).to.deep.eq({ 'a.Owner': { Name: 'n' } });
        expect(filterObject(['*', '!x.*.Password'], { 'x.y': { Password: 'h', Name: 'n' } })).to.deep.eq({ 'x.y': { Name: 'n' } });
        expect(filterObject(['*', '!*.Password'], { 'x.y': { Password: 'h' } })).to.deep.eq({ 'x.y': {} });
      });

      it('in write style: a client cannot slip a denied field through a dotted key', () => {
        const write = ['Name', 'Profile.*', '!Profile.Role'];
        const body = { Name: 'n', 'Profile.Role': 'admin', Profile: { Bio: 'b', Role: 'admin' } };
        expect(filterObject(write, body)).to.deep.eq({ Name: 'n', Profile: { Bio: 'b' } });
      });
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
      const out = filterObject(['*'], { x: data }) as { x: object };
      expect(Reflect.ownKeys(out.x)).to.deep.eq(['own']);
      expect(Object.getPrototypeOf(out.x)).to.eq(Object.prototype);
      const plain: Record<string | symbol, unknown> = { own: 1, [Symbol('s')]: 2 };
      Object.defineProperty(plain, 'hidden', { value: 3, enumerable: false });
      expect(Reflect.ownKeys(filterObject(['*'], plain))).to.deep.eq(['own']);
    });

    it('reads null-prototype objects as records', () => {
      const data = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: 2 });
      expect(filterObject(['a'], data)).to.deep.eq({ a: 1 });
    });

    it('drops __proto__ own keys', () => {
      const data = JSON.parse('{"__proto__": {"polluted": true}, "a": 1, "n": {"__proto__": {"polluted": true}, "b": 2}}') as Record<string, unknown>;
      for (const fields of [['*'], ['__proto__', 'a', 'n.*'], ['*', '__proto__.*']]) {
        const out = filterObject(fields, data) as Record<string, unknown>;
        expect(Object.getPrototypeOf(out)).to.eq(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).to.eq(false);
        expect(out).to.deep.eq({ a: 1, n: { b: 2 } });
        expect(out.polluted).to.eq(undefined);
      }
      expect(({} as Record<string, unknown>).polluted).to.eq(undefined);
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
