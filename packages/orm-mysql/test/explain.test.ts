import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { InvalidArgument } from '@spinajs/exceptions';
import { redactPlan } from '@spinajs/orm';
import type { PlanNode } from '@spinajs/orm';
import { normalizeMysqlPlan } from '../src/index.js';

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const asRows = (document: unknown) => [{ EXPLAIN: JSON.stringify(document) }];
const tablePlan = (table: Record<string, unknown>) => normalizeMysqlPlan(asRows({ query_block: { select_id: 1, table } }));

describe('normalizeMysqlPlan', () => {
  it('turns a nested loop join into a PlanNode tree (fixture snapshot)', () => {
    const document = load('explain-join.json');

    expect(normalizeMysqlPlan(asRows(document))).to.deep.equal({
      dialect: 'mysql',
      raw: document,
      root: {
        label: 'select #1',
        estimatedCost: 1.1,
        children: [
          {
            label: 'nested loop',
            children: [
              { label: 'u (const)', detail: 'key PRIMARY', estimatedRows: 1, estimatedCost: 0, children: [] },
              { label: 'o (ref)', detail: 'key explain_order_user', estimatedRows: 2, estimatedCost: 0.7, children: [] },
            ],
          },
        ],
      },
    });
  });

  it('nests ordering operations and attached subqueries (fixture snapshot)', () => {
    expect(normalizeMysqlPlan(asRows(load('explain-ordered-subquery.json'))).root).to.deep.equal({
      label: 'select #1',
      estimatedCost: 0.55,
      children: [
        {
          label: 'order',
          detail: 'using filesort',
          children: [
            {
              label: 'explain_user (ALL)',
              detail: 'where (0 <> (select count(0) from `test`.`explain_order` where (`test`.`explain_order`.`UserId` = `test`.`explain_user`.`Id`)))',
              estimatedRows: 3,
              estimatedCost: 0.55,
              children: [
                {
                  label: 'select #2',
                  estimatedCost: 0.35,
                  children: [{ label: 'explain_order (ref)', detail: 'key explain_order_user', estimatedRows: 1, estimatedCost: 0.35, children: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('keeps a message-only plan', () => {
    const rows = asRows({ query_block: { select_id: 1, message: 'Impossible WHERE' } });
    expect(normalizeMysqlPlan(rows).root).to.deep.equal({ label: 'select #1', children: [{ label: 'Impossible WHERE', children: [] }] });
  });

  it('rejects output it does not recognise', () => {
    expect(() => normalizeMysqlPlan([{ id: 1, select_type: 'SIMPLE' }])).to.throw(InvalidArgument);
  });

  it('nests the subqueries of a select list, ORDER BY, HAVING and GROUP BY, and a buffered result', () => {
    const subquery = (id: number) => [{ dependent: false, cacheable: true, query_block: { select_id: id, message: 'No tables used' } }];
    const rows = asRows({
      query_block: {
        select_id: 1,
        select_list_subqueries: subquery(2),
        ordering_operation: {
          using_filesort: false,
          order_by_subqueries: subquery(3),
          grouping_operation: {
            using_temporary_table: true,
            having_subqueries: subquery(4),
            group_by_subqueries: subquery(5),
            buffer_result: { using_temporary_table: true, table: { table_name: 't', access_type: 'ALL' } },
          },
        },
      },
    });
    const labels = (node: PlanNode): unknown[] => [node.label, ...node.children.map(labels)];
    const empty = (id: number) => [`select #${id}`, ['No tables used']];

    expect(labels(normalizeMysqlPlan(rows).root)).to.deep.equal(['select #1', empty(2), ['order', empty(3), ['group', empty(4), empty(5), ['buffer', ['t (ALL)']]]]]);
  });

  it('loses a bound value with an escaped quote when the slow-query capture redacts it (fixture)', () => {
    const redacted = redactPlan(normalizeMysqlPlan(asRows(load('explain-escaped-literal.json'))), false);

    expect(redacted.raw).to.equal(null);
    expect(redacted.root.children[0].detail).to.equal('where ((`test`.`explain_user`.`Name` = ?');
    expect(JSON.stringify(redacted)).to.not.contain('Brien');
  });

  it('replaces the literals of a condition that holds no backslash and keeps its shape', () => {
    const rows = asRows({ query_block: { select_id: 1, table: { table_name: 't', access_type: 'ALL', attached_condition: "((`t`.`Name` = 'O''Brien') and (`t`.`Id` > 7))" } } });

    expect(redactPlan(normalizeMysqlPlan(rows), false).root.children[0].detail).to.equal('where ((`t`.`Name` = ?) and (`t`.`Id` > ?))');
  });

  it('replaces every literal form of attached_condition, a double-quoted string included, and keeps the backticked names', () => {
    const condition =
      "((`t`.`Name` = 'sec-ret') and (`t`.`Alias` = \"dq-secret\") and (`t`.`Id` = 42) and (`t`.`Ratio` = 4.25) and (`t`.`Big` = 1e10) and (`t`.`Hex` = 0x1F) and (`t`.`Oct` = 0o17) and (`t`.`Bin` = 0b101) and (`t`.`Sep` = 1_000_000) and (`t`.`Mb` = _utf8mb4'mb-secret') and (`t`.`Fn` = concat('fn-secret',`t`.`Name`)))";
    const redacted = redactPlan(tablePlan({ table_name: 't', access_type: 'ALL', attached_condition: condition }), false);

    expect(redacted.root.children[0].detail).to.equal(
      'where ((`t`.`Name` = ?) and (`t`.`Alias` = ?) and (`t`.`Id` = ?) and (`t`.`Ratio` = ?) and (`t`.`Big` = ?) and (`t`.`Hex` = ?) and (`t`.`Oct` = ?) and (`t`.`Bin` = ?) and (`t`.`Sep` = ?) and (`t`.`Mb` = _utf8mb4?) and (`t`.`Fn` = concat(?,`t`.`Name`)))',
    );
    for (const value of ['sec-ret', 'dq-secret', '42', '4.25', '1e10', '0x1F', '0o17', '0b101', '1_000_000', 'mb-secret', 'fn-secret']) {
      expect(JSON.stringify(redacted)).to.not.contain(value);
    }
  });

  it('keeps used_key_parts, ref, index_condition and the other keys outside its vocabulary out of a redacted plan', () => {
    const plan = tablePlan({
      table_name: 't',
      access_type: 'ref',
      key: 'k',
      used_key_parts: ['kp-secret'],
      ref: ['const', "'ref-secret'"],
      index_condition: '(`t`.`A` > 31337)',
      partitions: ['p-secret'],
    });

    expect(plan.root.children).to.deep.equal([{ label: 't (ref)', detail: 'key k', children: [] }]);
    expect(JSON.stringify(plan.raw)).to.contain('kp-secret');
    expect(JSON.stringify(redactPlan(plan, false))).to.not.match(/secret|31337/);
  });
});
