import { expect } from 'chai';
import { checkSocketContract, authoritativeSchema, type Manifest, type SocketContractEntry, type SocketControllerEntry } from '../src/index.js';
import { src } from './support.js';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

function manifestOf(schemas: Record<string, unknown>): Manifest {
  return { schemas } as unknown as Manifest;
}

const ref = (schema: string) => ({ text: schema, schema });

const contract: SocketContractEntry = {
  id: 'app:C',
  commands: { 'docs.open': { payload: ref('P'), result: ref('R') } },
  events: {},
  clientEvents: { 'docs.ping': ref('P') },
  source: src('app'),
};

function controller(over: Partial<SocketControllerEntry['commands'][number]> = {}, events: SocketControllerEntry['events'] = [{ name: 'ping', payload: ref('P') }]): SocketControllerEntry {
  return {
    id: 'app:S',
    className: 'S',
    prefix: 'docs',
    contract: 'app:C',
    commands: [{ name: 'open', handler: 'open', payload: ref('P'), result: ref('R'), options: {}, policies: [], source: src('app'), ...over }],
    events,
    source: src('app'),
  };
}

describe('checkSocketContract', () => {
  const schemas = { P: obj({ id: { type: 'string' } }), R: obj({ id: { type: 'string' }, title: { type: 'string' } }) };

  it('accepts a handler that matches the contract', () => {
    expect(checkSocketContract(manifestOf(schemas), controller(), contract)).to.deep.equal([]);
  });

  it('SOCK001: a command or client event the contract declares has no handler', () => {
    const issues = checkSocketContract(manifestOf(schemas), controller({ name: 'close' }, []), contract);
    expect(issues.map((i) => [i.code, i.subject])).to.deep.equal([['SOCK001', 'docs.open'], ['SOCK001', 'docs.ping']]);
  });

  it('SOCK002: the handler accepts less than the contract lets a client send', () => {
    const narrow = { ...schemas, Q: obj({ id: { type: 'string' }, extra: { type: 'string' } }) };
    const issues = checkSocketContract(manifestOf(narrow), controller({ payload: ref('Q') }), contract);
    expect(issues.map((i) => i.code)).to.deep.equal(['SOCK002']);
  });

  it('SOCK003: the handler returns more than the contract promises', () => {
    const wide = { ...schemas, Q: obj({ id: { type: 'string' }, title: { type: ['string', 'null'] } }) };
    const issues = checkSocketContract(manifestOf(wide), controller({ result: ref('Q') }), contract);
    expect(issues.map((i) => i.code)).to.deep.equal(['SOCK003']);
  });

  it('skips a side without a schema or with a partial explicit schema', () => {
    const partial = { ...schemas, Q: { ...obj({ other: { type: 'number' } }), 'x-explicit': 'partial' } };
    expect(checkSocketContract(manifestOf(partial), controller({ payload: ref('Q'), result: { text: 'void' } }), contract)).to.deep.equal([]);
    expect(authoritativeSchema(manifestOf(partial), ref('Q'))).to.equal(undefined);
    expect(authoritativeSchema(manifestOf(partial), ref('P'))).to.equal('P');
  });
});
