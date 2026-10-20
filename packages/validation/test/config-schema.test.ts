import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';

import CONFIGURATION_SCHEMA from '../src/schemas/validation.js';

const children: IContainer[] = [];

async function boot(validation: Record<string, unknown>): Promise<Configuration> {
  const json = JSON.stringify({ validation });
  const child = DI.RootContainer.child();
  children.push(child);
  child.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }

        protected onLoad(): unknown {
          return JSON.parse(json) as unknown;
        }
      },
    )
    .as(Configuration);
  return child.resolve(Configuration);
}

describe('validation configuration schema', () => {
  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it("takes every value of Ajv's options: a boolean or one of its named modes", async () => {
    for (const validation of [
      { removeAdditional: 'all', useDefaults: 'empty', coerceTypes: 'array' },
      { removeAdditional: 'failing' },
      { removeAdditional: true, useDefaults: false, coerceTypes: true, allErrors: true, messages: false },
    ]) {
      const config = await boot(validation);
      expect(config.get('validation'), JSON.stringify(validation)).to.deep.eq(validation);
    }
  });

  it('refuses a mode Ajv does not have', async () => {
    for (const [key, value] of [['removeAdditional', 'empty'], ['useDefaults', 'all'], ['coerceTypes', 'yes']]) {
      const e = await boot({ [key]: value }).then(() => null, (err: unknown) => err);
      expect(e, `${key}: ${value}`).to.be.instanceOf(InvalidConfiguration);
      expect((e as InvalidConfiguration).violations.map((v) => v.path)).to.include(`validation.${key}`);
    }
  });
});
