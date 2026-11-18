/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ConstraintViolation, DataException, OrmException, QueryContext, UniqueViolation } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';
import { mapMySqlError } from '../src/errors.js';

const at = { Name: 'mysql' };
const mysqlError = (errno: number, code: string, message: string) => Object.assign(new Error(message), { errno, code, sqlState: '23000' });

describe('mapMySqlError', () => {
  it('maps ER_DUP_ENTRY to UniqueViolation with the MySQL 8 table.key name', () => {
    const err = mapMySqlError(mysqlError(1062, 'ER_DUP_ENTRY', "Duplicate entry 'a@x' for key 'users.users_email_unique'"), at, 'INSERT', []) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.table).to.eq('users');
    expect(err.constraint).to.eq('users_email_unique');
  });

  it('reads the MySQL 5.7 key name without a table', () => {
    const err = mapMySqlError(mysqlError(1062, 'ER_DUP_ENTRY', "Duplicate entry '1' for key 'PRIMARY'"), at, 'INSERT', []) as UniqueViolation;

    expect(err.table).to.eq(undefined);
    expect(err.constraint).to.eq('PRIMARY');
  });

  it('maps NOT NULL, foreign key and check errors to ConstraintViolation kinds', () => {
    const notNull = mapMySqlError(mysqlError(1048, 'ER_BAD_NULL_ERROR', "Column 'Email' cannot be null"), at, 'INSERT', []) as ConstraintViolation;
    const noDefault = mapMySqlError(mysqlError(1364, 'ER_NO_DEFAULT_FOR_FIELD', "Field 'Email' doesn't have a default value"), at, 'INSERT', []) as ConstraintViolation;
    const fk = mapMySqlError(mysqlError(1452, 'ER_NO_REFERENCED_ROW_2', 'Cannot add or update a child row: a foreign key constraint fails (`db`.`orders`, CONSTRAINT `orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`))'), at, 'INSERT', []) as ConstraintViolation;
    const check = mapMySqlError(mysqlError(3819, 'ER_CHECK_CONSTRAINT_VIOLATED', "Check constraint 'positive_qty' is violated."), at, 'INSERT', []) as ConstraintViolation;

    expect(notNull.kind).to.eq('not_null');
    expect(notNull.columns).to.deep.eq(['Email']);
    expect(noDefault.kind).to.eq('not_null');
    expect(fk.kind).to.eq('foreign_key');
    expect(fk.constraint).to.eq('orders_customer_fk');
    expect(check.kind).to.eq('check');
    expect(check.constraint).to.eq('positive_qty');
  });

  it('keeps every other error as OrmException', () => {
    const err = mapMySqlError(mysqlError(1146, 'ER_NO_SUCH_TABLE', "Table 'db.t' doesn't exist"), at, 'SELECT', []);

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ConstraintViolation);
    expect(err).to.not.be.instanceOf(DataException);
  });

  it('maps sqlState class 22 to DataException', () => {
    const native = Object.assign(new Error("Out of range value for column 'n' at row 1"), { errno: 1264, code: 'ER_WARN_DATA_OUT_OF_RANGE', sqlState: '22003' });

    expect(mapMySqlError(native, at, 'SELECT', [])).to.be.instanceOf(DataException);
  });

  // what MySQL 8 answers to `WHERE datetime_column > '10000-01-01 00:00:00.000'`
  it('maps ER_WRONG_VALUE, which MySQL reports with sqlState HY000, to DataException', () => {
    const native = Object.assign(new Error("Incorrect DATETIME value: '10000-01-01 00:00:00.000'"), { errno: 1525, code: 'ER_WRONG_VALUE', sqlState: 'HY000' });
    const err = mapMySqlError(native, { Name: 'mysql', Host: 'db', User: 'app' }, 'SELECT', ['10000-01-01 00:00:00.000']);

    expect(err).to.be.instanceOf(DataException);
    expect(err.message).to.contain('1525');
    expect(err.message).to.not.contain('10000');
    expect(err.cause).to.eq(native);
  });
});

describe('mysql driver error mapping', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('rejects a duplicate statement with UniqueViolation', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-errors-test', Driver: 'orm-driver-mysql' } as any]);
    const native = mysqlError(1062, 'ER_DUP_ENTRY', "Duplicate entry '1' for key 'PRIMARY'");
    const connection = {
      query: (_stmt: string, _params: unknown[], cb: (err: unknown) => void) => cb(native),
      release: () => undefined,
    };
    Object.assign(driver, { Pool: { getConnection: (cb: (err: unknown, connection: unknown) => void) => cb(null, connection) } });

    let err: UniqueViolation | undefined;
    try {
      await driver.executeOnDb('INSERT INTO t (id) VALUES (?)', [1], QueryContext.Insert);
    } catch (e) {
      err = e as UniqueViolation;
    }

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err?.inner).to.eq(native);
  });
});
