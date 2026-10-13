import { AuthzConfigError } from '@spinajs/authz';
import { expect } from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { RbacBound, RbacIdentifier, RbacOuterColumn, RbacSql, ident, joinSql, outer, outerColumnsOf, rebindOuter, rsql } from '../../src/orm/index.js';
import type { RbacSqlPart } from '../../src/orm/index.js';
import { wrap } from '../../src/orm/compile/kleene.js';

const SEED = Number(process.env.L4B_SEED ?? 20261010);

const tpl = (...strings: string[]): TemplateStringsArray => Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;

// The fragment layer as it was before fragments kept nested ones whole: every fragment copied its nested
// fragments' parts and checked all of its flattened text. The reference for the tree form.
const OLD_FORBIDDEN = new Set(['?', "'", '"', '`', ';', '$', '[', ']', '#', '\\', ':', '@']);

function oldAssertText(parts: readonly RbacSqlPart[]): void {
  let depth = 0;
  let prev = '';
  for (const part of parts) {
    if (typeof part !== 'string') {
      prev = '';
      continue;
    }
    for (const c of part) {
      if (OLD_FORBIDDEN.has(c)) throw new AuthzConfigError(`authz-rbac sql: has a '${c}' in its text; bind values and name columns with ident() or outer()`);
      if ((prev === '-' && c === '-') || (prev === '/' && c === '*')) throw new AuthzConfigError(`authz-rbac sql: has a '${prev}${c}' comment`);
      if (c === '(') depth++;
      else if (c === ')' && --depth < 0) throw new AuthzConfigError("authz-rbac sql: closes a bracket it did not open: ')' before its '('");
      prev = c;
    }
  }
  if (depth > 0) throw new AuthzConfigError(`authz-rbac sql: leaves ${depth} bracket(s) open`);
}

function oldBracketed(parts: readonly RbacSqlPart[]): boolean {
  let depth = 0;
  let first = true;
  let closedAtEnd = false;
  for (const p of parts) {
    if (typeof p !== 'string') {
      if (depth === 0) return false;
      first = false;
      closedAtEnd = false;
      continue;
    }
    for (const ch of p) {
      if (first && ch !== '(') return false;
      first = false;
      if (depth === 0 && closedAtEnd) return false;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        closedAtEnd = depth === 0;
        continue;
      }
      closedAtEnd = false;
    }
  }
  return !first && depth === 0 && closedAtEnd;
}

const oldOuterColumns = (parts: readonly RbacSqlPart[]): string[] => [...new Set(parts.filter((p): p is RbacOuterColumn => p instanceof RbacOuterColumn).map((p) => p.column))];

const show = (parts: readonly RbacSqlPart[]): unknown[] => parts.map((p) => (typeof p === 'string' ? p : p instanceof RbacOuterColumn ? ['o', p.column] : p instanceof RbacIdentifier ? ['i', ...p.names] : ['b', (p as RbacBound).value]));

type Arg = { bound: string | number } | { list: number[] } | { outer: string } | { ident: string } | { node: Node };
type Node = { template: string[]; args: Arg[] } | { join: Node[]; separator: string };

const textArb = fc.array(fc.constantFrom('a', ' ', '(', ')', '-', '/', '*', '()', ' AND ', '(a)', 'b = 1', '', '?'), { maxLength: 3 }).map((xs) => xs.join(''));
const nodeArb: fc.Arbitrary<Node> = fc.letrec<{ node: Node; arg: Arg }>((tie) => ({
  arg: fc.oneof({ depthSize: 'small', withCrossShrink: true }, fc.record({ bound: fc.oneof(fc.string({ maxLength: 2 }), fc.integer()) }), fc.record({ list: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 3 }) }), fc.record({ outer: fc.constantFrom('c1', 'c2', 'c3') }), fc.record({ ident: fc.constantFrom('t', 'u') }), fc.record({ node: tie('node') })),
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.array(tie('arg'), { maxLength: 4 }).chain((args) => fc.array(textArb, { minLength: args.length + 1, maxLength: args.length + 1 }).map((template) => ({ template, args }))),
    fc.record({ join: fc.array(tie('node'), { minLength: 1, maxLength: 4 }), separator: fc.constantFrom(', ', ' AND ', '-', ' /', '* ', ')') }),
  ),
})).node;

type Built = { ok: true; sql: RbacSql } | { ok: false; error: string };
type Reference = { ok: true; parts: RbacSqlPart[] } | { ok: false; error: string };

const message = (e: unknown): string => {
  if (!(e instanceof AuthzConfigError)) throw e;
  return e.message;
};

function build(node: Node): Built {
  try {
    if ('join' in node) {
      const parts = node.join.map(build);
      const failed = parts.find((p) => !p.ok);
      if (failed) return failed;
      return {
        ok: true,
        sql: joinSql(
          parts.map((p) => (p as { sql: RbacSql }).sql),
          node.separator,
        ),
      };
    }
    const args: unknown[] = [];
    for (const a of node.args) {
      if ('node' in a) {
        const b = build(a.node);
        if (!b.ok) return b;
        args.push(b.sql);
      } else args.push('bound' in a ? a.bound : 'list' in a ? a.list : 'outer' in a ? outer(a.outer) : ident(a.ident));
    }
    return { ok: true, sql: rsql(tpl(...node.template), ...(args as never[])) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

function reference(node: Node): Reference {
  const parts: RbacSqlPart[] = [];
  if ('join' in node) {
    for (const [i, n] of node.join.entries()) {
      const r = reference(n);
      if (!r.ok) return r;
      if (i > 0) parts.push(node.separator);
      parts.push(...r.parts);
    }
  } else {
    node.template.forEach((s, i) => {
      parts.push(s);
      if (i >= node.args.length) return;
      const a = node.args[i];
      if ('node' in a) {
        const r = reference(a.node);
        if (!r.ok) throw r;
        parts.push(...r.parts);
      } else if ('bound' in a) parts.push(new RbacBound(a.bound));
      else if ('list' in a) a.list.forEach((v, j) => (j > 0 ? parts.push(', ', new RbacBound(v)) : parts.push(new RbacBound(v))));
      else parts.push('outer' in a ? new RbacOuterColumn(a.outer) : new RbacIdentifier([a.ident]));
    });
  }
  try {
    oldAssertText(parts);
  } catch (e) {
    return { ok: false, error: message(e) };
  }
  return { ok: true, parts };
}

const referenceOf = (node: Node): Reference => {
  try {
    return reference(node);
  } catch (r) {
    return r as Reference;
  }
};

describe('authz-rbac orm-compile: rsql fragments kept as trees', () => {
  it(`random fragment trees flatten, refuse and bracket as the flat fragments did (seed ${SEED})`, () => {
    const stats = { built: 0, refused: 0 };
    fc.assert(
      fc.property(nodeArb, (node) => {
        const got = build(node);
        const want = referenceOf(node);
        if (!want.ok) {
          expect(got, JSON.stringify(node)).to.deep.equal({ ok: false, error: want.error });
          stats.refused++;
          return;
        }
        if (!got.ok) expect.fail(`refused ${got.error}: ${JSON.stringify(node)}`);
        stats.built++;
        const sql = got.sql;
        expect(show(sql.parts)).to.deep.equal(show(want.parts));
        expect(sql.bracketed).to.equal(oldBracketed(want.parts));
        expect(wrap(sql) === sql).to.equal(oldBracketed(want.parts));
        expect(outerColumnsOf(sql)).to.deep.equal(oldOuterColumns(want.parts));
        const rebound = rebindOuter(sql, 'x', (c) => `r_${c}`);
        expect(rebound).to.not.equal(sql);
        expect(show(rebound.parts)).to.deep.equal(show(want.parts.map((p) => (p instanceof RbacOuterColumn ? new RbacIdentifier(['x', `r_${p.column}`]) : p))));
        expect(outerColumnsOf(rebound)).to.deep.equal([]);
      }),
      { seed: SEED, numRuns: 3000 },
    );
    // Both outcomes must be common, or the property tests little.
    expect(stats.built).to.be.greaterThan(500);
    expect(stats.refused).to.be.greaterThan(500);
  });

  it('refuses a comment formed across a boundary in every position', () => {
    for (const [a, b] of [
      ['-', '-'],
      ['/', '*'],
    ]) {
      const cases: [string, () => RbacSql][] = [
        ['own text, then a nested fragment', () => rsql(tpl(`x ${a}`, ''), rsql(tpl(`${b} y`)))],
        ['a nested fragment, then own text', () => rsql(tpl('', `${b} y`), rsql(tpl(`x ${a}`)))],
        ['two adjacent nested fragments', () => rsql(tpl('', '', ''), rsql(tpl(`x ${a}`)), rsql(tpl(`${b} y`)))],
        ['across an empty nested fragment', () => rsql(tpl(`x ${a}`, `${b} y`), rsql``)],
        ['across a fragment holding only empty ones', () => rsql(tpl(`x ${a}`, `${b} y`), rsql`${rsql``}${rsql``}`)],
        ['into a fragment nested two deep', () => rsql(tpl(`x ${a}`, ''), rsql`${rsql(tpl(`${b} y`))}`)],
        ['out of a fragment nested two deep', () => rsql(tpl('', `${b} y`), rsql`${rsql(tpl(`x ${a}`))}`)],
        ['a separator after a fragment', () => joinSql([rsql(tpl(`x ${a}`)), rsql`y`], b)],
        ['a separator before a fragment', () => joinSql([rsql`x`, rsql(tpl(`${b} y`))], a)],
        ['own text pieces of one fragment', () => new RbacSql([`x ${a}`, `${b} y`])],
      ];
      for (const [where, f] of cases) expect(f, `${a}${b}: ${where}`).to.throw(AuthzConfigError, `has a '${a}${b}' comment`);
    }
    // A part between the two characters is no comment.
    expect(() => rsql(tpl('x -', ''), rsql`${ident('t')}- y`)).to.not.throw();
    expect(() => rsql(tpl('', '- y'), rsql`x -${ident('t')}`)).to.not.throw();
    expect(() => rsql`x -${1}- y`).to.not.throw();
  });

  it('refuses a forbidden character and an unbalanced bracket in its own text next to nested fragments', () => {
    const inner = rsql`(a = ${1})`;
    for (const c of ['?', "'", '"', '`', ';', '$', '[', ']', '#', '\\', ':', '@']) expect(() => rsql(tpl('', ` ${c}`), inner), c).to.throw(AuthzConfigError, `has a '${c}' in its text`);
    expect(() => rsql(tpl('(', ''), inner)).to.throw(AuthzConfigError, 'leaves 1 bracket(s) open');
    expect(() => rsql(tpl('', ')'), inner)).to.throw(AuthzConfigError, 'closes a bracket it did not open');
    expect(() => rsql(tpl(')', '('), inner)).to.throw(AuthzConfigError, 'closes a bracket it did not open');
    expect(() => joinSql([inner, inner], ') OR (')).to.throw(AuthzConfigError, 'closes a bracket it did not open');
    expect(() => rsql`((${inner}) AND ${inner})`).to.not.throw();
  });

  it('refuses an unbindable value given to the constructor', () => {
    for (const v of [Number.NaN, Infinity, 2n ** 60n, new Date(Number.NaN), null, true]) expect(() => new RbacSql(['a = ', new RbacBound(v as never)]), String(v)).to.throw(AuthzConfigError);
  });

  it('builds, flattens and rebinds a chain 20,000 fragments deep in linear time', () => {
    const depth = 20_000;
    const started = Date.now();
    let f = rsql`${outer('c')} = ${0}`;
    for (let i = 1; i <= depth; i++) f = rsql`(${f} AND b = ${i})`;
    const parts = f.parts;
    const rebound = rebindOuter(f, 'x');
    const reboundParts = rebound.parts;
    const elapsed = Date.now() - started;
    // The flat layer copied and scanned every level's parts again: 5.8 s at 8,000 levels, four times that per doubling.
    expect(elapsed).to.be.lessThan(2_000);
    expect(parts.length).to.equal(5 + 4 * depth);
    expect(parts.filter((p) => p instanceof RbacBound).length).to.equal(depth + 1);
    expect(f.bracketed).to.equal(true);
    expect(outerColumnsOf(f)).to.deep.equal(['c']);
    expect(show(reboundParts.slice(0, depth + 2))).to.deep.equal([...Array.from({ length: depth }, () => '('), '', ['i', 'x', 'c']]);
  });
});
