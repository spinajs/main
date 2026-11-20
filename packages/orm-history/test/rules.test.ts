import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import '@spinajs/log';
import { InvalidConfiguration } from '@spinajs/configuration';
import { ModelBase } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';
import { ruleFor } from '../src/rules.js';
import type { DataRule } from '../src/rules.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };

describe('audit.data.rules', function () {
  this.timeout(15000);

  class Order extends ModelBase {}
  class RushOrder extends Order {}
  class Note extends ModelBase {}

  it('takes the first rule that names the model, a base class of it, or everything', () => {
    const rules: DataRule[] = [{ models: ['Order'], trail: 'billing' }, { models: '*' }];
    expect(ruleFor(Order, rules)?.trail).to.eq('billing');
    expect(ruleFor(RushOrder, rules)?.trail).to.eq('billing');
    expect(ruleFor(Note, rules)).to.deep.eq({ models: '*' });
    expect(ruleFor(Note, [{ models: ['Order'] }])).to.eq(undefined);
    expect(ruleFor(Note, [])).to.eq(undefined);
  });

  it('accepts a rule list at boot and refuses a malformed change of it', async () => {
    const app = await createTestApp({ config: { logger: SILENT, audit: { data: { rules: [{ models: ['Order'], trail: 'billing' }, { models: '*' }] } } } });
    try {
      expect(app.config.get('audit.data.rules')).to.have.length(2);
      app.config.set('audit.data.rules', []);
      expect(() => app.config.set('audit.data.rules', [{ trail: 'billing' }])).to.throw(InvalidConfiguration);
      expect(() => app.config.set('audit.data.rules', [{ models: [] }])).to.throw(InvalidConfiguration);
      expect(() => app.config.set('audit.data.rules', [{ models: '*', trail: ' ' }])).to.throw(InvalidConfiguration);
      expect(() => app.config.set('audit.data.rules', [{ models: ['Invoice'], trial: 'billing' }])).to.throw(InvalidConfiguration);
      expect(app.config.get('audit.data.rules')).to.deep.eq([]);
    } finally {
      await app.dispose();
    }
  });

  it('fails the boot on a rule list the schema refuses', async () => {
    await expect(createTestApp({ config: { logger: SILENT, audit: { data: { rules: 'everything' } } } })).to.be.rejectedWith(InvalidConfiguration);
  });

  it('fails the boot on a misspelt key of the section or of a rule', async () => {
    await expect(createTestApp({ config: { logger: SILENT, audit: { data: { rule: [{ models: '*' }] } } } })).to.be.rejectedWith(InvalidConfiguration);
    await expect(createTestApp({ config: { logger: SILENT, audit: { data: { rules: [{ models: ['Invoice'], trial: 'billing' }] } } } })).to.be.rejectedWith(InvalidConfiguration);
  });
});
