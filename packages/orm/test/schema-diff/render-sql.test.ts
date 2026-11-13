import { expect } from 'chai';
import { NotSupported } from '@spinajs/exceptions';
import type { OrmDriver } from '../../src/driver.js';
import { renderSql } from '../../src/schema-diff/render-sql.js';
import type { SchemaChange } from '../../src/schema-diff/types.js';

const recording = { executeOnDb: () => Promise.resolve([]) };
const dropTable = (table: string, reason = 'gone'): SchemaChange => ({ kind: 'dropTable', table, detail: { table }, destructive: true, reason });

describe('renderSql', () => {
  it('keeps a step it cannot compile on one comment line, whatever the names and the error carry', async () => {
    const driver = { ...recording, schema: () => ({ dropTable: () => Promise.reject(new Error('boom\nDROP TABLE t')) }) } as unknown as OrmDriver;
    const lines = await renderSql([dropTable('a\r\nb c')], driver, { allowDestructive: true });
    expect(lines).to.deep.equal(['-- dropTable a  b c is not compiled offline: boom DROP TABLE t']);
  });

  it('runs a step that opens a transaction without opening one on the database', async () => {
    const driver = {
      ...recording,
      transaction: () => Promise.reject(new Error('opened a transaction')),
      schema(this: OrmDriver) {
        return { dropTable: () => this.transaction(() => Promise.resolve()) };
      },
    } as unknown as OrmDriver;
    expect(await renderSql([dropTable('a')], driver, { allowDestructive: true })).to.deep.equal([]);
  });

  it('names a DESTRUCTIVE step it leaves out on one comment line', async () => {
    const driver = { ...recording, schema: () => ({ dropTable: () => Promise.resolve() }) } as unknown as OrmDriver;
    expect(await renderSql([dropTable('a\nb', 'x\ny')], driver, { allowDestructive: false })).to.deep.equal(['-- DESTRUCTIVE dropTable a b: x y (left out; pass --allow-destructive)']);
  });

  it('refuses a driver that does not send its statements through executeOnDb', async () => {
    const driver = { schema: () => ({ dropTable: () => Promise.resolve() }) } as unknown as OrmDriver;
    const error = await renderSql([dropTable('a')], driver, { allowDestructive: true }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).to.be.instanceOf(NotSupported);
  });

  it('records a statement without the semicolon its compiler ends it with', async () => {
    const driver = {
      ...recording,
      schema(this: { executeOnDb(statement: string): Promise<unknown[]> }) {
        return { dropTable: () => this.executeOnDb('DROP TABLE "a";  ') };
      },
    } as unknown as OrmDriver;
    expect(await renderSql([dropTable('a')], driver, { allowDestructive: true })).to.deep.equal(['DROP TABLE "a"']);
  });
});
