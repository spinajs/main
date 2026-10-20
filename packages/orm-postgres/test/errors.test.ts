import 'mocha';
import { expect } from 'chai';
import { ConstraintViolation, OrmException, UniqueViolation } from '@spinajs/orm';
import { mapPostgresError } from '../src/index.js';

const at = { Name: 'postgres' };
const pgError = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message)), fields);

describe('mapPostgresError', () => {
  it('maps 23505 to UniqueViolation with the key columns from detail', () => {
    const err = mapPostgresError(
      pgError({ code: '23505', message: 'duplicate key value violates unique constraint "members_pkey"', table: 'members', constraint: 'members_pkey', detail: 'Key ("TeamId", user_id)=(1, 2) already exists.' }),
      at,
      'INSERT',
      [],
    ) as UniqueViolation;

    expect(err).to.be.instanceOf(UniqueViolation);
    expect(err.table).to.eq('members');
    expect(err.constraint).to.eq('members_pkey');
    expect(err.columns).to.deep.eq(['TeamId', 'user_id']);
  });

  it('maps the other class 23 codes to ConstraintViolation kinds', () => {
    const kind = (code: string) => (mapPostgresError(pgError({ code, message: code, column: 'c', table: 't' }), at, 'INSERT', []) as ConstraintViolation).kind;

    expect(kind('23502')).to.eq('not_null');
    expect(kind('23503')).to.eq('foreign_key');
    expect(kind('23514')).to.eq('check');
    expect(kind('23P01')).to.eq('other');
  });

  it('reports the column of a NOT NULL failure', () => {
    const err = mapPostgresError(pgError({ code: '23502', message: 'null value', column: 'email', table: 'users' }), at, 'INSERT', []) as ConstraintViolation;

    expect(err.table).to.eq('users');
    expect(err.columns).to.deep.eq(['email']);
  });

  it('keeps every other error as OrmException with inner', () => {
    const native = pgError({ code: '42P01', message: 'relation "t" does not exist' });
    const err = mapPostgresError(native, at, 'SELECT', []) as OrmException;

    expect(err).to.be.instanceOf(OrmException);
    expect(err).to.not.be.instanceOf(ConstraintViolation);
    expect(err.inner).to.eq(native);
  });
});
