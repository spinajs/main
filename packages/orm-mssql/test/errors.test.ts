/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ConstraintViolation, OrmException, QueryContext, UniqueViolation } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';
import { mapMsSqlError } from '../src/errors.js';

const at = { Name: 'mssql' };
const requestError = (number: number, message: string) => Object.assign(new Error(message), { name: 'RequestError', number });

describe('mapMsSqlError', () => {
  it('maps 2627 to UniqueViolation with the constraint and the object', () => {
    const err = mapMsSqlError(requestError(2627, "Violation of UNIQUE KEY constraint 'UQ_users_email'. Cannot insert duplicate key in object 'dbo.users'. The duplicate key value is (a@x)."), at, 'INSERT', []) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.constraint).to.eq('UQ_users_email');
    expect(err.table).to.eq('dbo.users');
  });

  it('maps 2601 to UniqueViolation with the unique index', () => {
    const err = mapMsSqlError(requestError(2601, "Cannot insert duplicate key row in object 'dbo.users' with unique index 'ix_users_login'. The duplicate key value is (bob)."), at, 'INSERT', []) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.constraint).to.eq('ix_users_login');
    expect(err.table).to.eq('dbo.users');
  });

  it('reads the number from originalError.info when the wrapper has none', () => {
    const err = mapMsSqlError(Object.assign(new Error("Violation of PRIMARY KEY constraint 'PK_t'."), { originalError: { info: { number: 2627 } } }), at, 'INSERT', []);

    expect(err).to.be.instanceOf(UniqueViolation);
  });

  it('maps 515 and 547 to ConstraintViolation kinds', () => {
    const notNull = mapMsSqlError(requestError(515, "Cannot insert the value NULL into column 'Email', table 'test.dbo.users'; column does not allow nulls. INSERT fails."), at, 'INSERT', []) as ConstraintViolation;
    const fk = mapMsSqlError(requestError(547, 'The INSERT statement conflicted with the FOREIGN KEY constraint "FK_orders_customers". The conflict occurred in database "test", table "dbo.customers", column \'id\'.'), at, 'INSERT', []) as ConstraintViolation;
    const check = mapMsSqlError(requestError(547, 'The INSERT statement conflicted with the CHECK constraint "CK_positive_qty". The conflict occurred in database "test", table "dbo.items", column \'qty\'.'), at, 'INSERT', []) as ConstraintViolation;

    expect(notNull.kind).to.eq('not_null');
    expect(notNull.columns).to.deep.eq(['Email']);
    expect(notNull.table).to.eq('test.dbo.users');
    expect(fk.kind).to.eq('foreign_key');
    expect(fk.constraint).to.eq('FK_orders_customers');
    expect(check.kind).to.eq('check');
    expect(check.constraint).to.eq('CK_positive_qty');
  });

  it('keeps every other error as OrmException', () => {
    const err = mapMsSqlError(requestError(208, "Invalid object name 't'."), at, 'SELECT', []);

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ConstraintViolation);
  });
});

describe('mssql driver error mapping', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('wraps a failed statement instead of rethrowing the RequestError', async () => {
    const driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-errors-test', Driver: 'orm-driver-mssql' } as any]);
    const native = requestError(2627, "Violation of PRIMARY KEY constraint 'PK_t'. Cannot insert duplicate key in object 'dbo.t'.");
    const request = {
      input: () => request,
      query: () => Promise.reject(native),
    };
    (driver as any)._connectionPool = { request: () => request };

    let err: any;
    try {
      await driver.executeOnDb('INSERT INTO t (id) VALUES (?)', [1], QueryContext.Insert);
    } catch (e) {
      err = e;
    }

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.inner).to.eq(native);
  });
});
