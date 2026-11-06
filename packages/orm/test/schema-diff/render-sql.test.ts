import { expect } from 'chai';
import type { OrmDriver } from '../../src/driver.js';
import { renderSql } from '../../src/schema-diff/render-sql.js';

describe('renderSql', () => {
  it('keeps a step it cannot compile on one comment line, whatever the names and the error carry', async () => {
    const driver = { schema: () => ({ dropTable: () => Promise.reject(new Error('boom\nDROP TABLE t')) }) } as unknown as OrmDriver;
    const lines = await renderSql([{ kind: 'dropTable', table: 'a\r\nb c', detail: { table: 'a' }, destructive: true, reason: 'gone' }], driver, { allowDestructive: true });
    expect(lines).to.deep.equal(['-- dropTable a  b c is not compiled offline: boom DROP TABLE t']);
  });

  it('runs a step that opens a transaction without opening one on the database', async () => {
    const driver = {
      transaction: () => Promise.reject(new Error('opened a transaction')),
      schema(this: OrmDriver) {
        return { dropTable: () => this.transaction(() => Promise.resolve()) };
      },
    } as unknown as OrmDriver;
    expect(await renderSql([{ kind: 'dropTable', table: 'a', detail: { table: 'a' }, destructive: true, reason: 'gone' }], driver, { allowDestructive: true })).to.deep.equal([]);
  });
});
