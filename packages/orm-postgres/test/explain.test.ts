import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { InvalidArgument } from '@spinajs/exceptions';
import { redactPlan } from '@spinajs/orm';
import { normalizePostgresPlan } from '../src/index.js';

const JOIN: unknown = JSON.parse(readFileSync(new URL('./fixtures/explain-join.json', import.meta.url), 'utf8'));

const JOIN_ROOT = {
  label: 'Nested Loop',
  detail: 'Inner join',
  estimatedRows: 2,
  estimatedCost: 16.42,
  children: [
    { label: 'Index Scan on explain_user u', detail: 'using explain_user_pkey; Index Cond: ("Id" = 1)', estimatedRows: 1, estimatedCost: 8.17, children: [] },
    { label: 'Seq Scan on explain_order o', detail: 'Filter: ("UserId" = 1)', estimatedRows: 2, estimatedCost: 8.23, children: [] },
  ],
};

// One literal of each form `sanitizeSql` replaces, plus a function call and quoted names that must survive.
const LITERALS = `("Name" = 'sec-ret'::text) AND ("Id" = 42) AND ("Ratio" = 4.25) AND ("Big" = 1e10) AND ("Hex" = 0x1F) AND ("Oct" = 0o17) AND ("Bin" = 0b101) AND ("Sep" = 1_000_000) AND (lower("Name") = lower('fn-secret'::text))`;
const SANITIZED = '("Name" = ?::text) AND ("Id" = ?) AND ("Ratio" = ?) AND ("Big" = ?) AND ("Hex" = ?) AND ("Oct" = ?) AND ("Bin" = ?) AND ("Sep" = ?) AND (lower("Name") = lower(?::text))';
const VALUES = ['sec-ret', '42', '4.25', '1e10', '0x1F', '0o17', '0b101', '1_000_000', 'fn-secret'];

const redacted = (plan: Record<string, unknown>) => redactPlan(normalizePostgresPlan([{ 'QUERY PLAN': [{ Plan: plan }] }]), true);

describe('normalizePostgresPlan', () => {
  it('turns a parsed json plan into a PlanNode tree (fixture snapshot)', () => {
    expect(normalizePostgresPlan([{ 'QUERY PLAN': JOIN }])).to.deep.equal({ dialect: 'postgres', raw: JOIN, root: JOIN_ROOT });
  });

  it('accepts the plan as json text', () => {
    expect(normalizePostgresPlan([{ 'QUERY PLAN': JSON.stringify(JOIN) }]).root).to.deep.equal(JOIN_ROOT);
  });

  it('lists sort keys and omits an alias equal to the relation', () => {
    const sorted = [{ Plan: { 'Node Type': 'Sort', 'Total Cost': 3.5, 'Plan Rows': 4, 'Sort Key': ['u."Name"', 'u."Id" DESC'], Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'explain_user', Alias: 'explain_user', 'Total Cost': 1.04, 'Plan Rows': 4 }] } }];

    expect(normalizePostgresPlan([{ 'QUERY PLAN': sorted }]).root).to.deep.equal({
      label: 'Sort',
      detail: 'Sort Key: u."Name", u."Id" DESC',
      estimatedRows: 4,
      estimatedCost: 3.5,
      children: [{ label: 'Seq Scan on explain_user', estimatedRows: 4, estimatedCost: 1.04, children: [] }],
    });
  });

  it('rejects output it does not recognise', () => {
    expect(() => normalizePostgresPlan([{ other: 1 }])).to.throw(InvalidArgument);
  });

  it('loses the bound values and keeps the identifiers when the slow-query capture redacts it', () => {
    const plan = redactPlan(normalizePostgresPlan([{ 'QUERY PLAN': JOIN }]), true);

    expect(plan.raw).to.equal(null);
    expect(plan.root.children.map((c) => c.detail)).to.deep.equal(['using explain_user_pkey; Index Cond: ("Id" = ?)', 'Filter: ("UserId" = ?)']);
  });

  it('cuts a condition at a literal that holds a backslash', () => {
    const plan = redacted({ 'Node Type': 'Seq Scan', 'Relation Name': 'explain_user', Filter: '("Name" = \'O\\\'Brien-secret\'::text)' });

    expect(plan.root.detail).to.equal('Filter: ("Name" = ?');
    expect(JSON.stringify(plan)).to.not.contain('Brien');
  });

  for (const field of ['Filter', 'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter', 'One-Time Filter']) {
    it(`replaces every literal form of ${field} and keeps the quoted names`, () => {
      const plan = redacted({ 'Node Type': 'Seq Scan', 'Relation Name': 'explain_user', [field]: `(${LITERALS})` });

      expect(plan.root.detail).to.equal(`${field}: (${SANITIZED})`);
      for (const value of VALUES) {
        expect(JSON.stringify(plan)).to.not.contain(value);
      }
    });
  }

  for (const field of ['Sort Key', 'Group Key']) {
    it(`replaces the literals of ${field} expressions`, () => {
      const plan = redacted({ 'Node Type': 'Aggregate', [field]: ['u."Name"', '(u."Id" + 31337)', `COALESCE(u."Name", 'anon-secret'::text)`] });

      expect(plan.root.detail).to.equal(`${field}: u."Name", (u."Id" + ?), COALESCE(u."Name", ?::text)`);
    });
  }

  it('keeps Output, Function Call and the other keys outside its vocabulary out of a redacted plan', () => {
    const node = {
      'Node Type': 'Function Scan',
      'Function Name': 'generate_series',
      Alias: 's',
      Output: [`'out-secret'::text`, '(s.s + 31337)'],
      'Function Call': 'generate_series(1, 31337)',
      'Cache Key': `'cache-secret'::text`,
      'Run Condition': '(row_number() OVER (?) <= 31337)',
    };
    const plan = normalizePostgresPlan([{ 'QUERY PLAN': [{ Plan: node }] }]);

    expect(plan.root).to.deep.equal({ label: 'Function Scan', children: [] });
    expect(JSON.stringify(plan.raw)).to.contain('out-secret');
    expect(JSON.stringify(redactPlan(plan, true))).to.not.match(/secret|31337/);
  });
});
