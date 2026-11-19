import 'mocha';
import { expect } from 'chai';
import { RawQuery } from '../src/builders.js';
import { RawQueryStatement } from '../src/statements.js';
import type { IQueryStatementResult } from '../src/statements.js';
import { noteRawSql, trackRawSql } from '../src/explain/raw-sql.js';

class TextStatement extends RawQueryStatement {
  public clone(): TextStatement {
    return new TextStatement(this._query, this._bindings);
  }

  public build(): IQueryStatementResult {
    return { Bindings: this._bindings, Statements: [this._query] };
  }
}

describe('trackRawSql', () => {
  it('reports a compile that reads RawQuery text', () => {
    const raw = RawQuery.create('a = 1');
    expect(trackRawSql(() => raw.Query)).to.deep.equal(['a = 1', true]);
  });

  it('reports a compile that only builds its own text as builder-made', () => {
    expect(trackRawSql(() => 'SELECT "a" FROM "t"')).to.deep.equal(['SELECT "a" FROM "t"', false]);
  });

  it('marks the text a RawQueryStatement took when the query was built, when the compile reads it', () => {
    const statement = trackRawSql(() => new TextStatement('a = 1'))[0];
    const [result, rawSql] = trackRawSql(() => statement.build());
    expect(result.Statements).to.deep.equal(['a = 1']);
    expect(rawSql).to.equal(true);
  });

  it('ignores raw text read outside a compile', () => {
    expect(RawQuery.create('a = 1').Query).to.equal('a = 1');
    noteRawSql();
    expect(trackRawSql(() => 1)[1]).to.equal(false);
  });

  it('reports raw text of a nested compile to the outer one too', () => {
    const [[, inner], outer] = trackRawSql(() => trackRawSql(() => noteRawSql()));
    expect(inner).to.equal(true);
    expect(outer).to.equal(true);
  });

  it('keeps an outer compile raw after a nested compile without raw text', () => {
    const [, outer] = trackRawSql(() => {
      noteRawSql();
      return trackRawSql(() => 1);
    });
    expect(outer).to.equal(true);
  });

  it('ends tracking when the compile throws', () => {
    expect(() => trackRawSql(() => { throw new Error('boom'); })).to.throw('boom');
    noteRawSql();
    expect(trackRawSql(() => 1)[1]).to.equal(false);
  });
});
