import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { Decision } from '../../../src/index.js';
import { RecordingLog, StaticModel, deny, permit, principal, registryOf } from '../fakes.js';
import type { StaticModelOptions } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');

const FAULTS: readonly [string, StaticModelOptions][] = [
  ['throws', { throws: new Error('kaput') }],
  ['sets error', { vote: { permitWhen: { op: 'true' }, error: 'store down' } }],
  ['times out', { vote: permit(), delayMs: 400 }],
];

let log: RecordingLog;
beforeEach(() => (log = new RecordingLog()));

const check = (algorithm: string, models: StaticModel[]): Promise<Decision> => new Authorizer({ domain: 'root', models, registry, log, combine: { default: { algorithm } }, config: { modelTimeoutMs: 50 } }).check({ principal: alice, permission: 'doc:read' });

describe('B04: indeterminate models', () => {
  for (const [fault, options] of FAULTS) {
    it(`B04: a model that ${fault} ⇒ deny model_error under deny-overrides, logged at error`, async () => {
      const d = await check('deny-overrides', [new StaticModel('ok', { vote: permit() }), new StaticModel('bad', options)]);
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'bad' });
      expect(log.at('error').length).to.be.greaterThan(0);
    });

    it(`B04: a model that ${fault} ⇒ deny model_error under first-applicable`, async () => {
      const d = await check('first-applicable', [new StaticModel('bad', options), new StaticModel('ok', { vote: permit() })]);
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'bad' });
      expect(log.at('error').length).to.be.greaterThan(0);
    });

    it(`B04: a model that ${fault} is ignored under permit-overrides when another model permits`, async () => {
      for (const order of [0, 1]) {
        const models = [new StaticModel('bad', options), new StaticModel('ok', { vote: permit() })];
        const d = await check('permit-overrides', order ? models.reverse() : models);
        expect(d.allowed).to.equal(true);
      }
    });

    it(`B04: a model that ${fault} alone under permit-overrides ⇒ model_error`, async () => {
      const d = await check('permit-overrides', [new StaticModel('bad', options), new StaticModel('no', { vote: deny() })]);
      expect(d.allowed).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'model_error', model: 'bad' });
    });
  }

  it('B04: the error text never reaches the reason', async () => {
    const d = await check('deny-overrides', [new StaticModel('bad', { throws: new Error('secret connection string') })]);
    expect(JSON.stringify(d.reason)).to.not.include('secret');
  });
});
