import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import type { ICompilerOutput } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, registerUowConnection, UowClient, UowOrder } from './uowFixture.js';

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  const out = query.toDB();
  return Array.isArray(out) ? out[0] : out;
}

describe("a join callback's builder", function () {
  this.timeout(30000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
  });
  afterEach(() => DI.clearCache());

  it('has no owner relation and is known as a join by its execution', () => {
    let inner: unknown;
    const keep = (builder: unknown): void => {
      inner = builder;
    };
    void UowOrder.query().leftJoin<UowClient>(
      UowClient,
      function () {
        this.where('Name', 'acme');
      },
      function () {
        keep(this);
      },
    );
    if (!(inner instanceof SelectQueryBuilder)) throw new Error('the join did not run the query callback');

    expect(inner.Owner).to.equal(undefined);
    expect(inner.state().owner).to.equal(undefined);
    expect(inner.state().execution).to.deep.equal({ kind: 'merged', into: 'join' });
  });

  it('still sends its conditions in the ON clause', async () => {
    const query = UowOrder.query().leftJoin<UowClient>(UowClient, function () {
      this.where('Name', 'acme');
    });
    const out = compiled(query);

    expect(String(out.expression)).to.contain('`$UowClient$`.`Name` = ?');
    expect(out.bindings).to.deep.equal(['acme']);
    expect(await query).to.have.length(1);
  });
});
