import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource, ConfigVar } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '../src/schemas.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const WITH_DEFAULTS = {
  $id: 'test-with-defaults',
  $configurationModule: 'withDefaults',
  type: 'object',
  properties: { timeoutMs: { type: 'integer', minimum: 1, default: 2000 } },
};

const REQUIRES_HOST = {
  $id: 'test-requires-host',
  $configurationModule: 'requiresHost',
  type: 'object',
  required: ['host'],
  properties: { host: { type: 'string' } },
};

const RANGE = {
  $id: 'test-range',
  $configurationModule: 'range',
  type: 'object',
  properties: {
    min: { type: 'integer' },
    max: { type: 'integer', minimum: { $data: '1/min' } },
  },
};

const ROLES = {
  $id: 'test-roles',
  $configurationModule: 'roles',
  type: 'object',
  properties: { roles: { type: 'object', propertyNames: { enum: ['a'] } } },
};

const NAMED_ROLES = {
  $id: 'test-named-roles',
  $configurationModule: 'namedRoles',
  type: 'object',
  propertyNames: { enum: ['a'] },
};

const FIELD_NAMED_AFTER_KEYWORD = {
  $id: 'test-keyword-field',
  $configurationModule: 'keywordField',
  type: 'object',
  properties: { propertyNames: { type: 'integer', minimum: 5 } },
};

const ESCAPED = {
  $id: 'test-escaped',
  $configurationModule: 'escaped',
  type: 'object',
  properties: { 'a/b': { type: 'integer', minimum: 5 }, 'c~d': { type: 'integer', minimum: 5 } },
};

const booted: IContainer[] = [];

async function boot(values: Record<string, unknown>, ...schemas: object[]) {
  const child = DI.child();
  booted.push(child);
  for (const s of schemas) child.register(s).asValue('__configurationSchema__');
  child.register(NoSource).as(ConfigurationSource);
  child.register(configurationOf(values)).as(Configuration);
  return { child, config: await child.resolve(Configuration) };
}

async function violationsOf(values: Record<string, unknown>, ...schemas: object[]) {
  try {
    await boot(values, ...schemas);
  } catch (e) {
    expect(e).to.be.instanceOf(InvalidConfiguration);
    return (e as InvalidConfiguration).violations;
  }
  throw new Error('expected InvalidConfiguration');
}

describe('configuration schema validation', () => {
  afterEach(async () => {
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  it('applies the defaults of a module that is not configured at all', async () => {
    const { config } = await boot({}, WITH_DEFAULTS);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('leaves an unconfigured module alone when its schema needs values', async () => {
    const { config } = await boot({}, REQUIRES_HOST);
    expect(config.get('requiresHost')).to.equal(undefined);
  });

  it('treats only undefined as not configured', async () => {
    const violations = await violationsOf({ withDefaults: null }, WITH_DEFAULTS);
    expect(violations.map((v) => v.path)).to.deep.equal(['withDefaults']);
  });

  describe('lineage', () => {
    const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
    let saved: unknown[] = [];

    beforeEach(() => {
      saved = [...schemas()];
    });

    afterEach(() => {
      DI.uncache('__configurationSchema__' as never);
      for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
    });

    it('validates with the schemas of every ancestor, not only the nearest container', async () => {
      DI.register(WITH_DEFAULTS).asValue('__configurationSchema__');
      await expect(boot({ requiresHost: { host: 'h' }, withDefaults: { timeoutMs: 0 } }, REQUIRES_HOST)).to.be.rejectedWith(InvalidConfiguration);
    });
  });

  it('names the full path, the schema and the message of every bad value', async () => {
    let error: unknown;
    try {
      await boot({ withDefaults: { timeoutMs: 0 } }, WITH_DEFAULTS);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidConfiguration);
    const [v] = (error as InvalidConfiguration).violations;
    expect(v).to.deep.include({ path: 'withDefaults.timeoutMs', schema: 'test-with-defaults' });
    expect(v.message).to.be.a('string').and.not.equal('');
    expect((error as Error).message).to.contain('withDefaults.timeoutMs').and.contain('test-with-defaults');
  });

  it('names the offending key of a propertyNames violation in one line', async () => {
    const violations = await violationsOf({ roles: { roles: { typo: 1 } } }, ROLES);
    expect(violations).to.have.length(1);
    expect(violations[0]).to.deep.include({ path: 'roles.roles.typo', schema: 'test-roles' });
    expect(violations[0].message).to.contain('property name');
  });

  it('names the offending key of a propertyNames violation at the module root', async () => {
    const violations = await violationsOf({ namedRoles: { typo: 1 } }, NAMED_ROLES);
    expect(violations.map((v) => v.path)).to.deep.equal(['namedRoles.typo']);
  });

  it('names the missing key of a required violation', async () => {
    const violations = await violationsOf({ requiresHost: {} }, REQUIRES_HOST);
    expect(violations.map((v) => v.path)).to.deep.equal(['requiresHost.host']);
  });

  it('does not mistake a field named propertyNames for a name check', async () => {
    const violations = await violationsOf({ keywordField: { propertyNames: 1 } }, FIELD_NAMED_AFTER_KEYWORD);
    expect(violations.map((v) => v.path)).to.deep.equal(['keywordField.propertyNames']);
  });

  it('decodes JSON Pointer escapes in the path', async () => {
    const violations = await violationsOf({ escaped: { 'a/b': 1, 'c~d': 1 } }, ESCAPED);
    expect(violations.map((v) => v.path)).to.have.members(['escaped.a/b', 'escaped.c~d']);
  });

  it('reports the violations of every schema, not only the first failing one', async () => {
    const violations = await violationsOf({ withDefaults: { timeoutMs: 0 }, range: { min: 10, max: 5 } }, WITH_DEFAULTS, RANGE);
    expect(violations.map((v) => v.path)).to.have.members(['withDefaults.timeoutMs', 'range.max']);
  });

  it('supports $data references between fields', async () => {
    await expect(boot({ range: { min: 10, max: 5 } }, RANGE)).to.be.rejectedWith(InvalidConfiguration);
    const { config } = await boot({ range: { min: 5, max: 10 } }, RANGE);
    expect(config.get('range.max')).to.equal(10);
  });

  it('validates and defaults a module whose schema is registered after the Configuration resolved', async () => {
    const { child, config } = await boot({});
    registerConfigurationSchema(WITH_DEFAULTS, child);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('fails at registration when the already loaded module violates the late schema', async () => {
    const { child } = await boot({ range: { min: 10, max: 5 } });
    expect(() => registerConfigurationSchema(RANGE, child)).to.throw(InvalidConfiguration);
  });

  it('applies a schema registered while the sources are still loading', async () => {
    const child = DI.child();
    booted.push(child);
    child.register(NoSource).as(ConfigurationSource);
    child
      .register(
        class extends FrameworkConfiguration {
          protected loadSources(): void {
            this.Sources = [];
          }

          protected onLoad(): unknown {
            child.register(WITH_DEFAULTS).asValue('__configurationSchema__');
            return {};
          }
        },
      )
      .as(Configuration);

    const config = await child.resolve(Configuration);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('leaves the parent Configuration alone when the container has its own, unresolved one', async () => {
    const C = configurationOf({ range: { min: 10, max: 5 } });
    const child = DI.child();
    booted.push(child);
    child.register(NoSource).as(ConfigurationSource);
    child.register(C).as(Configuration);
    await child.resolve(Configuration);

    const own = child.child();
    booted.push(own);
    own.register(C).as(Configuration);

    expect(() => registerConfigurationSchema(RANGE, own)).to.not.throw();
  });

  it('validates against the Configuration of the nearest ancestor that has one', async () => {
    const { child } = await boot({ range: { min: 10, max: 5 } });
    const grandchild = child.child();
    booted.push(grandchild);

    expect(() => registerConfigurationSchema(RANGE, grandchild)).to.throw(InvalidConfiguration);
  });

  describe('registering a schema more than once', () => {
    const bad = { range: { min: 10, max: 5 } };

    it('adds it once and reports each violation once, also for a copy with the same $id', async () => {
      const child = DI.child();
      booted.push(child);
      registerConfigurationSchema(RANGE, child);
      registerConfigurationSchema(RANGE, child);
      registerConfigurationSchema({ ...RANGE }, child);
      expect(child.Cache.get('__configurationSchema__', false)).to.deep.equal([RANGE]);

      child.register(NoSource).as(ConfigurationSource);
      child.register(configurationOf(bad)).as(Configuration);
      const e = await child.resolve(Configuration).then(() => null, (err: unknown) => err);
      expect(e).to.be.instanceOf(InvalidConfiguration);
      expect((e as InvalidConfiguration).violations.map((v) => v.path)).to.deep.equal(['range.max']);
    });

    it('validates the copy of a schema that is already compiled, after boot, without an Ajv duplicate id error', async () => {
      const { child, config } = await boot({ range: { min: 1, max: 5 } }, RANGE);
      expect(() => registerConfigurationSchema({ ...RANGE }, child)).to.not.throw();
      expect(config.get('range.max')).to.equal(5);
    });

    it('applies the defaults again without changing them (a Bootstrapper after a module-level registration)', async () => {
      const { child, config } = await boot({});
      registerConfigurationSchema(WITH_DEFAULTS, child);
      config.set('withDefaults.timeoutMs', 50);
      registerConfigurationSchema(WITH_DEFAULTS, child);
      expect(config.get('withDefaults')).to.deep.equal({ timeoutMs: 50 });
    });
  });

  describe('a late schema that refuses the loaded value', () => {
    const bad = { range: { min: 10, max: 5 }, other: { a: 1 } };

    it('makes every read of the module throw, naming the path and the schema, until it validates', async () => {
      const { child, config } = await boot(bad);
      expect(() => registerConfigurationSchema(RANGE, child)).to.throw(InvalidConfiguration);

      for (const path of ['range.max', 'range', ['range', 'min'], '']) {
        const e = (() => {
          try {
            config.get(path);
          } catch (err) {
            return err;
          }
          return null;
        })();
        expect(e, String(path)).to.be.instanceOf(InvalidConfiguration);
        expect((e as InvalidConfiguration).violations).to.deep.equal([{ path: 'range.max', schema: 'test-range', message: 'must be >= 10' }]);
        expect((e as InvalidConfiguration).message).to.contain('range.max').and.contain('test-range');
      }
      expect(config.get('other.a')).to.equal(1);
      expect(config.get('rangeX', 'none')).to.equal('none');

      config.set('range.max', 20);
      registerConfigurationSchema(RANGE, child);
      expect(config.get('range.max')).to.equal(20);
    });

    it('registerConfigurationSchemaAtImport does not throw: the import goes on, the reads of the module fail', async () => {
      const { child, config } = await boot(bad);
      expect(() => registerConfigurationSchemaAtImport(RANGE, child)).to.not.throw();
      expect(() => config.get('range.max')).to.throw(InvalidConfiguration, /range\.max/);
      expect(config.get('other.a')).to.equal(1);
    });

    it('registerConfigurationSchemaAtImport applies the defaults of a module loaded after boot', async () => {
      const { child, config } = await boot({});
      registerConfigurationSchemaAtImport(WITH_DEFAULTS, child);
      expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
    });
  });

  describe('a failing check leaves the stored value as it was', () => {
    // Ajv runs `if` before `properties` coerces: a refused null would otherwise be stored as 0, and pass the next check.
    const NULL_GUARD = {
      $id: 'test-null-guard',
      $configurationModule: 'guard',
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 0, default: 30 } },
      if: { properties: { seconds: { const: null } }, required: ['seconds'] },
      then: { properties: { seconds: false } },
    };

    const raw = (config: Configuration) => (config as FrameworkConfiguration).RootConfig.guard as Record<string, unknown>;

    it('stays refused when the schema is registered again (a copy, a Bootstrapper, a re-check)', async () => {
      const { child, config } = await boot({ guard: { seconds: null } });
      registerConfigurationSchemaAtImport(NULL_GUARD, child);
      expect(() => config.get('guard.seconds')).to.throw(InvalidConfiguration);

      expect(() => registerConfigurationSchema({ ...NULL_GUARD }, child)).to.throw(InvalidConfiguration);
      expect(() => registerConfigurationSchema(NULL_GUARD, child)).to.throw(InvalidConfiguration);
      expect(() => (config as FrameworkConfiguration).validateModule(NULL_GUARD)).to.throw(InvalidConfiguration);
      expect(() => config.get('guard.seconds')).to.throw(InvalidConfiguration);
      expect(raw(config)).to.deep.equal({ seconds: null });
    });

    it('refuses the boot without changing the stored value', async () => {
      let instance: FrameworkConfiguration | undefined;
      const Base = configurationOf({ guard: { seconds: null } });
      const child = DI.child();
      booted.push(child);
      child.register(NoSource).as(ConfigurationSource);
      child.register(class extends Base {
        constructor() {
          super();
          instance = this;
        }
      }).as(Configuration);
      child.register(NULL_GUARD).asValue('__configurationSchema__');

      await expect(child.resolve(Configuration)).to.be.rejectedWith(InvalidConfiguration);
      expect(raw(instance!)).to.deep.equal({ seconds: null });
    });

    it('checking a valid section again changes nothing', async () => {
      const { child, config } = await boot({ guard: { seconds: 5 }, withDefaults: { timeoutMs: '7' } }, NULL_GUARD, WITH_DEFAULTS);
      const guard = config.get('guard');
      const before = JSON.stringify((config as FrameworkConfiguration).RootConfig);
      registerConfigurationSchema(NULL_GUARD, child);
      registerConfigurationSchema(WITH_DEFAULTS, child);
      expect(JSON.stringify((config as FrameworkConfiguration).RootConfig)).to.equal(before);
      expect(config.get('guard')).to.equal(guard);
      expect(config.get('withDefaults.timeoutMs')).to.equal(7);
    });
  });

  it('applies a schema registered after the check ran but before the Configuration is cached', async () => {
    const child = DI.child();
    booted.push(child);
    child.register(NoSource).as(ConfigurationSource);
    const Base = configurationOf({});
    child.register(class extends Base {
      protected configure(): void {
        super.configure();
        registerConfigurationSchema(WITH_DEFAULTS, child);
      }
    }).as(Configuration);

    const config = await child.resolve(Configuration);
    expect(config.get('withDefaults.timeoutMs')).to.equal(2000);
  });

  it('forgets the checked Configuration when its boot fails after the check', async () => {
    const child = DI.child();
    booted.push(child);
    child.register(NoSource).as(ConfigurationSource);
    const Base = configurationOf({ range: { min: 10, max: 5 } });
    child.register(class extends Base {
      protected configure(): void {
        throw new Error('configure failed');
      }
    }).as(Configuration);

    await expect(child.resolve(Configuration)).to.be.rejectedWith('configure failed');
    expect(FrameworkConfiguration.checkedIn(child)).to.equal(undefined);
    expect(() => registerConfigurationSchema(RANGE, child)).to.not.throw();
  });

  describe('the copy the check validates first', () => {
    class Secret {
      #value: string;

      constructor(value: string) {
        this.#value = value;
      }

      public get value() {
        return this.#value;
      }
    }

    const LAZY = {
      $id: 'test-lazy',
      $configurationModule: 'lazy',
      type: 'object',
      properties: {
        named: { type: 'integer', minimum: 1 },
        deep: { type: 'object', properties: { named: { type: 'integer', minimum: 1 } } },
        list: { type: 'array', items: { type: 'object' } },
      },
    };

    const HOLDER = {
      $id: 'test-holder',
      $configurationModule: 'holder',
      type: 'object',
      properties: { key: { type: 'object', required: ['value'], properties: { value: { type: 'string', minLength: 1 } } } },
    };

    async function bootRaw(values: () => Record<string, unknown>, ...schemas: object[]) {
      const child = DI.child();
      booted.push(child);
      for (const s of schemas) child.register(s).asValue('__configurationSchema__');
      child.register(NoSource).as(ConfigurationSource);
      child.register(class extends FrameworkConfiguration {
        protected loadSources(): void {
          this.Sources = [];
        }

        protected onLoad(): unknown {
          return values();
        }
      }).as(Configuration);
      return { child, config: await child.resolve(Configuration) };
    }

    // The check before the copy-first one read the stored value alone, through the same proxies: a var loaded only
    // when the schema reads its key, and an array element (never proxied) checked as the ConfigVar object itself.
    it('loads only the ConfigVars under keys the schema reads, at any depth, and leaves array elements alone', async () => {
      const loaded: string[] = [];
      const lazy = (name: string, value: unknown) => new ConfigVar(() => (loaded.push(name), value));
      const element = lazy('list.0', 's');
      const { config } = await bootRaw(
        () => ({ lazy: { named: lazy('named', 5), unnamed: lazy('unnamed', 's'), deep: { named: lazy('deep.named', 6), unnamed: lazy('deep.unnamed', 's') }, list: [element] } }),
        LAZY,
      );
      expect(loaded).to.have.members(['named', 'deep.named']);
      expect(config.get('lazy.deep.named')).to.equal(6);
      expect(config.get('lazy.deep.unnamed')).to.equal('s');
      expect(config.get<unknown[]>('lazy.list')[0]).to.equal(element);
      expect(loaded).to.have.members(['named', 'deep.named', 'deep.unnamed']);
    });

    it('validates the value of a ConfigVar the schema names, at any depth', async () => {
      for (const [values, path] of [
        [{ named: new ConfigVar(() => 0) }, 'lazy.named'],
        [{ deep: { named: new ConfigVar(() => 0) } }, 'lazy.deep.named'],
      ] as const) {
        const e = await bootRaw(() => ({ lazy: values }), LAZY).then(() => null, (err: unknown) => err);
        expect(e, path).to.be.instanceOf(InvalidConfiguration);
        expect((e as InvalidConfiguration).violations.map((v) => v.path)).to.deep.equal([path]);
      }
    });

    it('checks a class instance with private fields through its getters, keeping the instance', async () => {
      const key = new Secret('k');
      const { config } = await bootRaw(() => ({ holder: { key } }), HOLDER);
      expect(config.get('holder.key')).to.equal(key);

      const e = await bootRaw(() => ({ holder: { key: new Secret('') } }), HOLDER).then(() => null, (err: unknown) => err);
      expect(e).to.be.instanceOf(InvalidConfiguration);
      expect((e as InvalidConfiguration).violations.map((v) => v.path)).to.deep.equal(['holder.key.value']);
    });
  });
});
