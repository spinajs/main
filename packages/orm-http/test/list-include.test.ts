import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { MAX_INCLUDES, readInclude } from '../src/include.js';
import { req } from './common.js';
import { startListServer, stopListServer } from './list-server.js';

type Row = { Customer?: { Name?: string } };

describe('readInclude', () => {
  const INCLUDABLE = ['Customer', 'Lines'];

  it('answers nothing for an absent or empty value', () => {
    expect(readInclude(undefined, INCLUDABLE)).to.deep.equal([]);
    expect(readInclude('', INCLUDABLE)).to.deep.equal([]);
  });

  it('reads a comma separated text, a JSON list and a list, without repeats', () => {
    expect(readInclude('Customer, Lines', INCLUDABLE)).to.deep.equal(['Customer', 'Lines']);
    expect(readInclude('["Lines","Customer","Lines"]', INCLUDABLE)).to.deep.equal(['Lines', 'Customer']);
    expect(readInclude(['Customer'], INCLUDABLE)).to.deep.equal(['Customer']);
  });

  it('refuses a relation outside the list, naming the allowed ones', () => {
    expect(() => readInclude('Secrets', INCLUDABLE)).to.throw(InvalidArgument, /Customer, Lines/);
  });

  it('refuses anything that is no text or list of text, and a list over the cap', () => {
    expect(() => readInclude({ Customer: true }, INCLUDABLE)).to.throw(InvalidArgument);
    expect(() => readInclude([1], INCLUDABLE)).to.throw(InvalidArgument);
    expect(() => readInclude(Array.from({ length: MAX_INCLUDES + 1 }, () => 'Customer'), INCLUDABLE)).to.throw(InvalidArgument);
  });
});

describe('include over HTTP', function () {
  this.timeout(30000);

  before(startListServer);
  after(stopListServer);

  const get = (path: string, include?: string) => {
    const request = req().get(path).set('Accept', 'application/json');
    return include === undefined ? request : request.query({ include });
  };

  it('@Include populates an includable relation', async () => {
    const response = await get('lq/orders', 'Customer');
    expect(response).to.have.status(200);
    expect((response.body as Row[])[0].Customer).to.include({ Name: 'acme' });
  });

  it('@Include answers 400 for a relation the model does not mark', async () => {
    expect(await get('lq/orders', 'Secrets')).to.have.status(400);
  });

  it('@Include is an empty list when the request names none', async () => {
    const response = await get('lq/orders');
    expect(response).to.have.status(200);
    expect((response.body as Row[])[0].Customer?.Name).to.equal(undefined);
  });

  it('@FromModel refuses a relation outside the list once the model marks any', async () => {
    expect(await get('lq/orders/1', 'Secrets')).to.have.status(400);
  });

  it('@FromModel still populates a marked relation', async () => {
    const response = await get('lq/orders/1', 'Customer');
    expect(response).to.have.status(200);
    expect((response.body as Row).Customer).to.include({ Name: 'acme' });
  });
});
