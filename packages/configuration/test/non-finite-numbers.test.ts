import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, ConfigVar, ConfigVarProtocol } from '@spinajs/configuration-common';

import { NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TIMER = {
  $id: 'test-non-finite-timer',
  $configurationModule: 'timer',
  type: 'object',
  properties: {
    intervalMs: { type: 'integer', minimum: 1, maximum: 2147483647 },
    ratio: { type: 'number', exclusiveMinimum: 0 },
  },
};

const NON_FINITE = ['Infinity', '-Infinity', '1e999'];

const booted: IContainer[] = [];

async function boot(values: () => Record<string, unknown>, setup?: (c: IContainer) => void) {
  const child = DI.child();
  booted.push(child);
  child.register(TIMER).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  setup?.(child);
  child
    .register(
      class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }

        protected onLoad(): unknown {
          return values();
        }
      },
    )
    .as(Configuration);
  return (await child.resolve(Configuration)) as FrameworkConfiguration;
}

async function refusal(boot: Promise<unknown>): Promise<InvalidConfiguration> {
  try {
    await boot;
  } catch (e) {
    expect(e).to.be.instanceOf(InvalidConfiguration);
    return e as InvalidConfiguration;
  }
  throw new Error('expected InvalidConfiguration');
}

function setRefusal(fn: () => unknown): InvalidConfiguration {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(InvalidConfiguration);
    return e as InvalidConfiguration;
  }
  throw new Error('expected InvalidConfiguration');
}

describe('configuration refuses coerced non-finite numbers', () => {
  afterEach(async () => {
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  for (const raw of NON_FINITE) {
    it(`refuses '${raw}' for an integer with limits at boot, with a violation at the path`, async () => {
      const e = await refusal(boot(() => ({ timer: { intervalMs: raw } })));
      expect(e.violations).to.deep.equal([{ path: 'timer.intervalMs', schema: 'test-non-finite-timer', message: 'must be a finite number' }]);
    });

    it(`refuses '${raw}' for a number with an exclusive minimum at boot`, async () => {
      const e = await refusal(boot(() => ({ timer: { ratio: raw } })));
      expect(e.violations.map((v) => v.path)).to.deep.equal(['timer.ratio']);
    });

    it(`refuses set() of '${raw}' and keeps the previous value`, async () => {
      const config = await boot(() => ({ timer: { intervalMs: 1000 } }));
      const e = setRefusal(() => config.set('timer.intervalMs', raw));
      expect(e.violations.map((v) => v.path)).to.deep.equal(['timer.intervalMs']);
      expect(config.get('timer.intervalMs')).to.equal(1000);
    });
  }

  it('still coerces a finite numeric string', async () => {
    const config = await boot(() => ({ timer: { intervalMs: '250', ratio: '0.5' } }));
    expect(config.get('timer')).to.deep.equal({ intervalMs: 250, ratio: 0.5 });
  });

  it('refuses a literal non-finite number under a key the schema does not type', async () => {
    const e = await refusal(boot(() => ({ timer: { intervalMs: 5, extra: { limit: Infinity } } })));
    expect(e.violations.map((v) => v.path)).to.deep.equal(['timer.extra.limit']);
  });

  it('refuses a non-finite number a ConfigVar yields, and leaves the vars the schema does not read unloaded', async () => {
    let unreadCalls = 0;
    class TimerProtocol extends ConfigVarProtocol {
      public get Protocol() {
        return 'timer-var://';
      }

      public getVar(path: string): Promise<ConfigVar> {
        return Promise.resolve(
          new ConfigVar(() => {
            if (path === 'unread') unreadCalls++;
            return path === 'interval' ? 'Infinity' : path;
          }),
        );
      }
    }

    const register = (c: IContainer) => c.register(TimerProtocol).as(ConfigVarProtocol);
    const e = await refusal(boot(() => ({ timer: { intervalMs: 'timer-var://interval', other: 'timer-var://unread' } }), register));
    expect(e.violations.map((v) => v.path)).to.deep.equal(['timer.intervalMs']);
    expect(unreadCalls).to.equal(0);
  });
});
