import 'mocha';
import { expect } from 'chai';
import { Exception, ResourceDuplicated } from '@spinajs/exceptions';
import { ConstraintViolation, OrmException, UniqueViolation } from '../src/exceptions.js';

describe('constraint violation exceptions', () => {
  it('UniqueViolation is a ResourceDuplicated that keeps the native error', () => {
    const native = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
    const err = new UniqueViolation(native.message, { table: 'users', constraint: 'users_email_key', columns: ['email'] }, native);

    expect(err).to.be.instanceOf(ResourceDuplicated);
    expect(err).to.be.instanceOf(Exception);
    expect(err).to.not.be.instanceOf(OrmException);
    expect(err.message).to.eq('duplicate key value violates unique constraint "users_email_key"');
    expect(err.inner).to.eq(native);
    expect(err.table).to.eq('users');
    expect(err.constraint).to.eq('users_email_key');
    expect(err.columns).to.deep.eq(['email']);
  });

  it('UniqueViolation leaves what the driver did not report undefined', () => {
    const err = new UniqueViolation('duplicate');

    expect(err.table).to.eq(undefined);
    expect(err.constraint).to.eq(undefined);
    expect(err.columns).to.eq(undefined);
    expect(err.inner).to.eq(undefined);
  });

  it('ConstraintViolation is an OrmException with a kind, and not a duplicate', () => {
    const native = new Error('null value in column "email" violates not-null constraint');
    const err = new ConstraintViolation(native.message, 'not_null', { table: 'users', columns: ['email'] }, undefined, 'INSERT INTO users', ['x'], native);

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ResourceDuplicated);
    expect(err.kind).to.eq('not_null');
    expect(err.table).to.eq('users');
    expect(err.columns).to.deep.eq(['email']);
    expect(err.query).to.eq('INSERT INTO users');
    expect(err.bindings).to.deep.eq(['x']);
    expect(err.inner).to.eq(native);
    expect(err.message).to.eq('null value in column "email" violates not-null constraint');
  });
});
