import { expect } from 'chai';
import type { Diagnostic } from '@spinajs/manifest';
import { autoIncrementOf, buildTargetSchema, columnSpecOf } from '../../src/schema-diff/target.js';
import { col, id, manifestOf, model, SOURCE } from './fixture.js';

describe('buildTargetSchema', () => {
  it('unions the columns of every model on one table (D19 rule 1)', () => {
    const tables = buildTargetSchema(
      manifestOf([model('UserBase', 'users', [id(), col('Email', { family: 'text', length: 200 })]), model('User', 'users', [id(), col('Name', { family: 'text', inferred: true }, { nullable: true })])]),
      'default',
    );
    expect(tables.map((t) => [t.name, t.models, t.columns.map((c) => c.name)])).to.deep.equal([['users', ['UserBase', 'User'], ['Id', 'Email', 'Name']]]);
  });

  it('lets an explicit spec win over an inferred one of the same family', () => {
    const diagnostics: Diagnostic[] = [];
    const [users] = buildTargetSchema(manifestOf([model('A', 'users', [col('Email', { family: 'text', inferred: true })]), model('B', 'users', [col('Email', { family: 'text', length: 200 })])]), 'default', diagnostics);
    expect(users.columns[0].sql).to.deep.equal({ family: 'text', length: 200 });
    expect(diagnostics).to.deep.equal([]);
  });

  it('reports MIG001 when two explicit specs, or two families, differ', () => {
    const diagnostics: Diagnostic[] = [];
    buildTargetSchema(
      manifestOf([
        model('A', 'users', [col('Email', { family: 'text', length: 100 }), col('Age', { family: 'integer', inferred: true })]),
        model('B', 'users', [col('Email', { family: 'text', length: 200 }), col('Age', { family: 'text', inferred: true })]),
      ]),
      'default',
      diagnostics,
    );
    expect(diagnostics).to.deep.equal([
      { code: 'MIG001', severity: 'error', message: 'column users.Email is declared with different specs by A, B: {"family":"text","length":100} and {"family":"text","length":200}', source: SOURCE },
      { code: 'MIG001', severity: 'error', message: 'column users.Age is declared with different specs by A, B: {"family":"integer"} and {"family":"text"}', source: SOURCE },
    ]);
  });

  it('allows NULL when any model does, and never on a primary key', () => {
    const [t] = buildTargetSchema(
      manifestOf([model('A', 't', [col('Note', { family: 'text', inferred: true })]), model('B', 't', [col('Note', { family: 'text', inferred: true }, { nullable: true }), col('Id', { family: 'integer', inferred: true }, { primary: true, nullable: true })])]),
      'default',
    );
    expect(t.columns.map((c) => [c.name, c.nullable, c.primary])).to.deep.equal([
      ['Note', true, false],
      ['Id', false, true],
    ]);
  });

  it('keeps the models of the connection and its aliases; a model naming none is on default', () => {
    const tables = buildTargetSchema(manifestOf([model('Z', 'z', [id()]), model('B', 'b', [id()], { connection: 'primary' }), model('C', 'c', [id()], { connection: 'reports' })]), ['default', 'primary']);
    expect(tables.map((t) => t.name)).to.deep.equal(['b', 'z']);
  });

  it('derives a foreign key from a belongsTo whose target is on the connection, referencing the target primary key', () => {
    const tables = buildTargetSchema(
      manifestOf([
        model('Company', 'companies', [id()]),
        model('User', 'users', [id(), col('CompanyId', { family: 'integer', inferred: true })], {
          relations: [
            { name: 'Company', kind: 'belongsTo', target: 'Company', foreignKey: 'CompanyId' },
            { name: 'Team', kind: 'belongsTo', target: 'Team', foreignKey: 'TeamId' },
            { name: 'Posts', kind: 'hasMany', target: 'Post', foreignKey: 'UserId' },
          ],
        }),
      ]),
      'default',
    );
    expect(tables.find((t) => t.name === 'users')?.foreignKeys).to.deep.equal([{ column: 'CompanyId', table: 'companies', references: 'Id' }]);
  });

  it('marks a table exhaustive when any of its models is, and keeps one copy of an @Index', () => {
    const [t] = buildTargetSchema(
      manifestOf([model('A', 't', [id()], { exhaustive: true, indexes: [{ columns: ['Id'], unique: false }] }), model('B', 't', [id()], { indexes: [{ columns: ['Id'], unique: false }] })]),
      'default',
    );
    expect([t.exhaustive, t.indexes]).to.deep.equal([true, [{ columns: ['Id'], unique: false }]]);
  });

  it('infers a family from the TypeScript type of a column without sql (fragments built before @Column)', () => {
    const bare = (text: string): unknown => columnSpecOf({ name: 'x', type: { text }, primary: false, nullable: false });
    expect(['number', 'string', 'boolean', 'Date', 'DateTime', 'Uint8Array', 'string[]'].map((t) => bare(t))).to.deep.equal([
      { family: 'integer', inferred: true },
      { family: 'text', inferred: true },
      { family: 'boolean', inferred: true },
      { family: 'datetime', inferred: true },
      { family: 'datetime', inferred: true },
      { family: 'binary', inferred: true },
      { family: 'json', inferred: true },
    ]);
  });

  it('auto-increments an inferred integer primary key and otherwise follows the spec', () => {
    expect(autoIncrementOf({ primary: true, sql: { family: 'integer', inferred: true } })).to.equal(true);
    expect(autoIncrementOf({ primary: true, sql: { family: 'integer', autoIncrement: false } })).to.equal(false);
    expect(autoIncrementOf({ primary: true, sql: { family: 'uuid', inferred: true } })).to.equal(false);
    expect(autoIncrementOf({ primary: false, sql: { family: 'integer', inferred: true } })).to.equal(false);
  });
});
