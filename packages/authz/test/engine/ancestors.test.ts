import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { GLOBAL } from '../../src/index.js';
import type { ResourceRef } from '../../src/index.js';
import { FakeAdapter, FakeRow, RecordingAudit, RecordingLog, fakeClock, registryOf } from './fakes.js';

const expect = chai.expect;

const F1: ResourceRef = { type: 'folder', id: 'f1' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };

const authorizer = () =>
  new Authorizer({
    domain: 'root',
    registry: registryOf([{ name: 'doc:read', types: ['doc'] }]),
    models: [],
    adapters: [new FakeAdapter(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, F1), new FakeRow('folder', 'f1')] })],
    clock: fakeClock().clock,
    audit: new RecordingAudit(),
    log: new RecordingLog(),
  });

describe('Authorizer.ancestors', () => {
  it('answers the path a check walks: the resource, its ancestors, then $global', async () => {
    expect(await authorizer().ancestors(D1)).to.deep.equal([D1, F1, GLOBAL]);
  });

  it('answers null for an unknown resource and [type, $global] at the type level', async () => {
    const a = authorizer();
    expect(await a.ancestors({ type: 'doc', id: 'missing' })).to.equal(null);
    expect(await a.ancestors({ type: 'doc' })).to.deep.equal([{ type: 'doc' }, GLOBAL]);
  });
});
