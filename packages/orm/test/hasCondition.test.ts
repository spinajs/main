/* eslint-disable @typescript-eslint/no-explicit-any */
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import { IQueryStatementResult, WhereBuilder, WhereQueryStatement } from '../src/index.js';

const expect = chai.expect;

type GroupClass = abstract new (builder: WhereBuilder<any>, not?: boolean) => WhereQueryStatement;

function groupOf(Base: GroupClass) {
  return class extends Base {
    public build(): IQueryStatementResult {
      return { Statements: [], Bindings: [] };
    }

    public clone(): WhereQueryStatement {
      return this;
    }
  };
}

class Condition {
  public TableAlias = '';
  public Boolean: any;
  public build(): IQueryStatementResult {
    return { Statements: ['1 = 1'], Bindings: [] };
  }
  public clone() {
    return this;
  }
}

describe('WhereBuilder.hasCondition()', () => {
  const builder = () => new WhereBuilder<any>({ Container: DI, Model: undefined, TableAlias: 't' } as any);

  // The cjs and mjs builds of the ORM can be loaded side by side; a query string loads a second
  // copy of statements.ts with its own WhereQueryStatement class.
  let ForeignWhereQueryStatement: GroupClass;

  before(async () => {
    const copy = await import(new URL('../src/statements.js?second-copy', import.meta.url).href);
    ForeignWhereQueryStatement = copy.WhereQueryStatement;
    expect(ForeignWhereQueryStatement).to.not.equal(WhereQueryStatement);
  });

  it('is false for an empty builder and true for one with a statement', () => {
    expect(builder().hasCondition()).to.be.false;
    const b = builder();
    b.Statements.push(new Condition() as any);
    expect(b.hasCondition()).to.be.true;
  });

  it('looks through groups: only empty groups are no condition', () => {
    const Group = groupOf(WhereQueryStatement);
    const outer = builder();
    outer.Statements.push(new Group(builder()));
    expect(outer.hasCondition()).to.be.false;

    const inner = builder();
    inner.Statements.push(new Condition() as any);
    outer.Statements.push(new Group(inner));
    expect(outer.hasCondition()).to.be.true;
  });

  it('recognises a group built from a second copy of the ORM', () => {
    const Group = groupOf(ForeignWhereQueryStatement);
    const outer = builder();
    outer.Statements.push(new Group(builder()));
    expect(outer.hasCondition(), 'an empty foreign group').to.be.false;

    const inner = builder();
    inner.Statements.push(new Condition() as any);
    outer.Statements.push(new Group(inner));
    expect(outer.hasCondition()).to.be.true;
  });
});
