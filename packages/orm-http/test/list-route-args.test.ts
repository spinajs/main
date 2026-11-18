import 'mocha';
import { expect } from 'chai';
import { req } from './common.js';
import { startListServer, stopListServer } from './list-server.js';

describe('@Aggregate route argument', function () {
  this.timeout(30000);

  before(startListServer);
  after(stopListServer);

  const get = (aggregate?: unknown) => {
    const request = req().get('lq/aggregate').set('Accept', 'application/json');
    return aggregate === undefined ? request : request.query({ aggregate: typeof aggregate === 'string' ? aggregate : JSON.stringify(aggregate) });
  };

  it('hands the handler the parsed request', async () => {
    const response = await get({ groupBy: ['Status'], measures: [{ name: 'total', fn: 'sum', column: 'Amount' }], order: [{ column: 'Status' }] });
    expect(response).to.have.status(200);
    expect((response.body as { aggregates: unknown }).aggregates).to.deep.equal([
      { Status: 'open', total: 200 },
      { Status: 'paid', total: 750 },
    ]);
  });

  it('is undefined when the request sends none', async () => {
    const response = await get();
    expect(response).to.have.status(200);
    expect((response.body as { aggregates: unknown }).aggregates).to.equal(null);
  });

  it('answers 400 for a column outside the allow-list', async () => {
    expect(await get({ groupBy: ['Note'], measures: [{ name: 'n', fn: 'count' }] })).to.have.status(400);
  });

  it('answers 400 for a function the column does not allow', async () => {
    expect(await get({ measures: [{ name: 'n', fn: 'sum', column: 'CustomerId' }] })).to.have.status(400);
  });

  it('answers 400 for malformed JSON', async () => {
    expect(await get('{"measures":')).to.have.status(400);
  });

  describe('over a model without @Groupable or @Aggregatable columns', () => {
    const ofCustomers = (aggregate: unknown) => req().get('lq/customers/aggregate').set('Accept', 'application/json').query({ aggregate: JSON.stringify(aggregate) });

    it('counts its rows', async () => {
      const response = await ofCustomers({ measures: [{ name: 'n', fn: 'count' }] });
      expect(response).to.have.status(200);
      expect((response.body as { aggregates: unknown }).aggregates).to.deep.equal([{ n: 3 }]);
    });

    it('answers 400 for a group column', async () => {
      expect(await ofCustomers({ groupBy: ['Name'], measures: [{ name: 'n', fn: 'count' }] })).to.have.status(400);
    });

    it('answers 400 for a counted column', async () => {
      expect(await ofCustomers({ measures: [{ name: 'n', fn: 'count', column: 'Name' }] })).to.have.status(400);
    });
  });
});
