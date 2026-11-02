import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

import { NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';
import { registerConfigurationSchemaAtImport } from '../src/schemas.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const MAILER = {
  $id: 'test-set-mailer',
  $configurationModule: 'mailer',
  type: 'object',
  properties: {
    retryCount: { type: 'integer', minimum: 0, default: 3 },
    timeoutMs: { type: 'integer', minimum: 1, default: 2000 },
  },
};

const NESTED = {
  $id: 'test-set-nested',
  $configurationModule: 'app.mail.smtp',
  type: 'object',
  properties: { port: { type: 'integer', minimum: 1 } },
};

// The parent refuses an empty section, as authz does for authz.admin.guard, whose child schema lives in authz-rbac.
const OWNER = {
  $id: 'test-set-owner',
  $configurationModule: 'owner',
  type: 'object',
  properties: { flag: { type: 'boolean' }, section: { type: 'object', required: ['needed'] } },
};

const SECTION = {
  $id: 'test-set-owner-section',
  $configurationModule: 'owner.section',
  type: 'object',
  properties: { extra: { type: 'array' } },
};

const booted: IContainer[] = [];

async function boot(values: () => Record<string, unknown>, ...schemas: object[]) {
  const child = DI.child();
  booted.push(child);
  for (const s of schemas) child.register(s).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
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

function violationPaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    expect(e).to.be.instanceOf(InvalidConfiguration);
    return (e as InvalidConfiguration).violations.map((v) => v.path);
  }
  throw new Error('expected InvalidConfiguration');
}

function sourceOf(values: Record<string, unknown>) {
  return class extends ConfigurationSource {
    public get Order() {
      return 0;
    }

    public Load(): Promise<IConfigLike> {
      return Promise.resolve(JSON.parse(JSON.stringify(values)) as IConfigLike);
    }
  };
}

describe('configuration set, merge and reload validation', () => {
  afterEach(async () => {
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  describe('prototype pollution', () => {
    it('refuses set() and merge() through __proto__, constructor and prototype', async () => {
      const config = await boot(() => ({ app: {} }));
      for (const path of ['__proto__.polluted', ['app', '__proto__'], 'app.constructor.prototype', 'constructor']) {
        expect(() => config.merge(path, { polluted: true })).to.throw(InvalidArgument);
        expect(() => config.set(path, { polluted: true })).to.throw(InvalidArgument);
      }
      expect(({} as Record<string, unknown>).polluted).to.equal(undefined);
    });
  });

  describe('set()', () => {
    it('refuses an invalid value inside a module and keeps the previous one', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      expect(violationPaths(() => config.set('mailer.retryCount', -1))).to.deep.equal(['mailer.retryCount']);
      expect(config.get('mailer.retryCount')).to.equal(5);
    });

    it('refuses an invalid module and keeps the previous one', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      expect(violationPaths(() => config.set('mailer', { retryCount: 1, timeoutMs: 0 }))).to.deep.equal(['mailer.timeoutMs']);
      expect(config.get('mailer')).to.deep.equal({ retryCount: 5, timeoutMs: 2000 });
    });

    it('checks a module under the path it replaces', async () => {
      const config = await boot(() => ({ app: { mail: { smtp: { port: 25 } } } }), NESTED);
      expect(violationPaths(() => config.set('app', { mail: { smtp: { port: 0 } } }))).to.deep.equal(['app.mail.smtp.port']);
      expect(config.get('app.mail.smtp.port')).to.equal(25);
    });

    it('applies a valid value with the schema defaults and coercion', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      config.set('mailer', { retryCount: '7' });
      expect(config.get('mailer')).to.deep.equal({ retryCount: 7, timeoutMs: 2000 });
    });

    it('does not coerce or default the caller value of a refused change', async () => {
      const config = await boot(() => ({}), MAILER);
      const value = { retryCount: '7', timeoutMs: 0 };
      expect(() => config.set('mailer', value)).to.throw(InvalidConfiguration);
      expect(value).to.deep.equal({ retryCount: '7', timeoutMs: 0 });
    });

    it('leaves paths no schema covers unchecked', async () => {
      const config = await boot(() => ({}), MAILER);
      config.set('free.retryCount', -1);
      config.set(['mailerExtra', 'x'], 'anything');
      expect(config.get('free.retryCount')).to.equal(-1);
      expect(config.get('mailerExtra.x')).to.equal('anything');
    });

    it('lifts the refusal of a late schema once a valid value is set', async () => {
      const config = await boot(() => ({ late: { n: 0 } }));
      const container = booted[booted.length - 1];
      const LATE = { $id: 'test-set-late', $configurationModule: 'late', type: 'object', properties: { n: { type: 'integer', minimum: 1 } } };
      registerConfigurationSchemaAtImport(LATE, container);
      expect(() => config.get('late.n')).to.throw(InvalidConfiguration);

      config.set('late.n', 2);
      expect(config.get('late.n')).to.equal(2);
    });
  });

  describe('merge()', () => {
    it('refuses an invalid value and keeps the previous one', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      expect(violationPaths(() => config.merge('mailer', { retryCount: -1 }))).to.deep.equal(['mailer.retryCount']);
      expect(config.get('mailer.retryCount')).to.equal(5);
    });

    it('applies a valid value with coercion', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      config.merge('mailer', { timeoutMs: '10' });
      expect(config.get('mailer')).to.deep.equal({ retryCount: 5, timeoutMs: 10 });
    });

    it('leaves paths no schema covers unchecked', async () => {
      const config = await boot(() => ({ free: { a: 1 } }), MAILER);
      config.merge('free', { b: -1 });
      expect(config.get('free')).to.deep.equal({ a: 1, b: -1 });
    });
  });

  describe('mergeSource()', () => {
    it('refuses a source with an invalid value: nothing is merged and the source is not kept', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      await expect(config.mergeSource(sourceOf({ mailer: { retryCount: -1 }, other: 1 }))).to.be.rejectedWith(InvalidConfiguration);
      expect(config.get('mailer.retryCount')).to.equal(5);
      expect(config.get('other')).to.equal(undefined);

      await config.load();
      expect(config.get('mailer.retryCount')).to.equal(5);
    });

    it('merges a valid source with the schema defaults', async () => {
      const config = await boot(() => ({ free: 1 }), MAILER);
      config.set('mailer', undefined);
      await config.mergeSource(sourceOf({ mailer: { retryCount: 1 } }));
      expect(config.get('mailer')).to.deep.equal({ retryCount: 1, timeoutMs: 2000 });
    });
  });

  describe("a schema with no defaults under another schema's module", () => {
    for (const [order, schemas] of [
      ['parent first', [OWNER, SECTION]],
      ['child first', [SECTION, OWNER]],
    ] as const) {
      it(`leaves the unset section unset, ${order}, so a later set of the parent module passes`, async () => {
        const config = await boot(() => ({ owner: { flag: true } }), ...schemas);
        expect(config.get('owner.section')).to.equal(undefined);
        config.set('owner.flag', false);
        expect(config.get('owner.flag')).to.equal(false);
      });
    }

    it('still judges a section that was set', async () => {
      await expect(boot(() => ({ owner: { section: {} } }), OWNER, SECTION)).to.be.rejectedWith(InvalidConfiguration);
    });

    it('still gives a module with no parent its empty object', async () => {
      const config = await boot(() => ({}), NESTED);
      expect(config.get('app.mail.smtp')).to.deep.equal({});
    });

    it('still gives a module its empty object when the parent accepts one', async () => {
      const config = await boot(() => ({}), { ...OWNER, $id: 'test-set-open-owner', properties: { section: { type: 'object' } } }, SECTION);
      expect(config.get('owner.section')).to.deep.equal({});
    });
  });

  describe('load()', () => {
    it('applies the schema defaults again on a reload', async () => {
      const config = await boot(() => ({ mailer: { retryCount: 5 } }), MAILER);
      await config.load();
      expect(config.get('mailer')).to.deep.equal({ retryCount: 5, timeoutMs: 2000 });
    });

    it('refuses a reload with an invalid value and keeps the previous tree', async () => {
      let retryCount = 5;
      const config = await boot(() => ({ mailer: { retryCount } }), MAILER);
      retryCount = -1;
      await expect(config.load()).to.be.rejectedWith(InvalidConfiguration);
      expect(config.get('mailer')).to.deep.equal({ retryCount: 5, timeoutMs: 2000 });
    });
  });
});
