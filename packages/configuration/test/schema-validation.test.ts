import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { FrameworkConfiguration } from '../src/configuration.js';
import { InvalidConfiguration } from '../src/exception.js';
import { registerConfigurationSchema } from '../src/schemas.js';

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
});
