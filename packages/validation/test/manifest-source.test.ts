import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { MANIFEST_VERSION, type Manifest } from '@spinajs/manifest';
import '@spinajs/log';

import { ManifestSchemaSource, manifestSchemaKey, manifestValidatorOf, prepareManifestSchemas } from '../src/manifest-source.js';
import { ValidationFailed } from '../src/exceptions/index.js';
import { DataValidator } from '../src/validator.js';

class QuietConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      validation: { allErrors: true, coerceTypes: true, useDefaults: true, messages: false },
    };
  }
}

const closed = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });

function manifestOf(schemas: Record<string, unknown>): Manifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    app: { name: 'test-app', version: '0.0.0', root: process.cwd(), outDir: 'lib' },
    packages: [],
    generatedAt: '1970-01-01T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schemas: Object.fromEntries(Object.entries(schemas).map(([id, schema]) => [id, { $id: id, ...(schema as object) }])),
    schedules: [],
    commands: [],
    queueMessages: [],
    diagnostics: [],
  };
}

const SCHEMAS = {
  'spinajs/app/Item': { ...closed({ name: { type: 'string' }, count: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, ['name', 'count']), 'x-derived': { type: 'object' } },
  'spinajs/app/Named': closed({ name: { type: 'string' } }),
  'spinajs/app/Counted': closed({ count: { type: 'number' } }),
  'spinajs/app/Both': { allOf: [{ $ref: 'spinajs/app/Named' }, { $ref: 'spinajs/app/Counted' }] },
  'spinajs/app/NamedAndAnything': { allOf: [{ $ref: 'spinajs/app/Named' }, { type: 'object' }] },
  'spinajs/app/Inline': { allOf: [closed({ a: { type: 'string' } }), closed({ b: { type: 'number' } })] },
  'spinajs/app/Partial': { ...closed({ name: { type: 'string' } }), 'x-explicit': 'partial' },
  'spinajs/app/Envelope': closed({ item: { $ref: 'spinajs/app/Partial' }, inner: { $ref: 'spinajs/app/Both' } }, ['item']),
  'spinajs/app/User': { type: 'object' },
  'spinajs/app/Holder': closed({ user: { $ref: 'spinajs/app/User' } }),
  'spinajs/app/Query': closed({ page: { type: 'number' }, exact: { anyOf: [{ type: 'boolean' }] }, ids: { type: 'array', items: { type: 'number' } } }, ['page']),
  'spinajs/app/Dangling': closed({ x: { $ref: 'spinajs/app/Missing' } }),
  'spinajs/app/Odd': closed({ 'x-header': { type: 'string' } }),
};

const errorOf = (fn: () => void): ValidationFailed => {
  try {
    fn();
  } catch (err) {
    return err as ValidationFailed;
  }
  throw new Error('expected a validation error');
};

describe('manifest schemas', function () {
  this.timeout(15000);

  const manifest = manifestOf(SCHEMAS);
  const body = (id: string) => manifestValidatorOf(manifest).validator(id, { coerce: false });

  describe('prepareManifestSchemas', () => {
    it('gives every schema an absolute $id, absolute $refs and no x-* keywords', () => {
      const prepared = prepareManifestSchemas(manifest);
      const item = prepared.find((s) => s.$id === manifestSchemaKey('spinajs/app/Item'));
      const envelope = prepared.find((s) => s.$id === manifestSchemaKey('spinajs/app/Envelope'));
      expect(item).to.not.have.property('x-derived');
      expect((envelope?.properties as Record<string, unknown>).inner).to.deep.equal({ $ref: manifestSchemaKey('spinajs/app/Both') });
    });

    it('keeps a property named like an extension keyword', () => {
      const odd = prepareManifestSchemas(manifest).find((s) => s.$id === manifestSchemaKey('spinajs/app/Odd'));
      expect(odd?.properties).to.have.property('x-header');
    });

    it('accepts anything for an x-explicit partial schema: the runtime @Schema is the contract', () => {
      const partial = prepareManifestSchemas(manifest).find((s) => s.$id === manifestSchemaKey('spinajs/app/Partial'));
      expect(partial).to.deep.equal({ $id: manifestSchemaKey('spinajs/app/Partial') });
    });
  });

  describe('manifestValidatorOf', () => {
    it('accepts a valid body and rejects a wrong type with ValidationFailed', () => {
      expect(() => body('spinajs/app/Item')({ name: 'a', count: 1 })).to.not.throw();
      const error = errorOf(() => body('spinajs/app/Item')({ name: 'a', count: 'hunter2-secret' }));
      expect(error).to.be.instanceOf(ValidationFailed);
      expect(error.details.map((d) => d.field)).to.deep.equal(['/count']);
      expect(JSON.stringify(error)).to.not.include('hunter2-secret');
    });

    it('never coerces a body', () => {
      expect(() => body('spinajs/app/Item')({ name: 'a', count: '2' })).to.throw(ValidationFailed);
    });

    it('coerces query values in place to the schema types', () => {
      const query: Record<string, unknown> = { page: '2', exact: 'true', ids: '7' };
      manifestValidatorOf(manifest).validator('spinajs/app/Query', { coerce: true })(query);
      expect(query).to.deep.equal({ page: 2, exact: true, ids: [7] });
      expect(() => manifestValidatorOf(manifest).validator('spinajs/app/Query', { coerce: true })({ page: 'two' })).to.throw(ValidationFailed);
    });

    it('accepts keys the schema does not declare at the root only when asked', () => {
      const query = { page: '1', debug: 'yes' };
      expect(() => manifestValidatorOf(manifest).validator('spinajs/app/Query', { coerce: true })({ ...query })).to.throw(ValidationFailed);
      expect(() => manifestValidatorOf(manifest).validator('spinajs/app/Query', { coerce: true, openRoot: true })({ ...query })).to.not.throw();
    });

    it('treats an intersection of closed objects as one closed object', () => {
      expect(() => body('spinajs/app/Both')({ name: 'a', count: 1 })).to.not.throw();
      expect(() => body('spinajs/app/Both')({ name: 'a' })).to.throw(ValidationFailed);
      expect(() => body('spinajs/app/Both')({ name: 'a', count: 1, extra: true })).to.throw(ValidationFailed);
      expect(() => body('spinajs/app/Inline')({ a: 'x', b: 1 })).to.not.throw();
      expect(() => body('spinajs/app/Envelope')({ item: {}, inner: { name: 'a', count: 1 } })).to.not.throw();
    });

    it('leaves an intersection with an open member open', () => {
      expect(() => body('spinajs/app/NamedAndAnything')({ name: 'a', extra: true })).to.not.throw();
    });

    it('accepts anything where a partial or an open dependency model is referenced', () => {
      expect(() => body('spinajs/app/Envelope')({ item: { name: 1, extra: true } })).to.not.throw();
      expect(() => body('spinajs/app/Holder')({ user: { Password: 'x', Anything: 1 } })).to.not.throw();
    });

    it('compiles a schema once per coercion mode', () => {
      const validators = manifestValidatorOf(manifest);
      expect(validators.validator('spinajs/app/Item', { coerce: false })).to.equal(validators.validator('spinajs/app/Item', { coerce: false }));
      expect(manifestValidatorOf(manifest)).to.equal(validators);
    });

    it('throws a message without schema internals when a schema cannot compile', () => {
      expect(() => body('spinajs/app/Dangling')).to.throw(/unresolved \$ref spinajs\/app\/Missing/);
      expect(() => body('spinajs/app/Unknown')).to.throw(/spinajs\/app\/Unknown is not in the manifest/);
    });
  });

  describe('ManifestSchemaSource', () => {
    afterEach(() => {
      DI.clearCache();
    });

    it('loads nothing without a manifest decision', async () => {
      const child = DI.child({ isolateSingletons: true });
      expect(await child.resolve(ManifestSchemaSource).Load()).to.deep.equal([]);
    });

    it('loads nothing in off mode', async () => {
      const child = DI.child({ isolateSingletons: true });
      registerManifest(child, manifest);
      registerManifestSettings(child, { mode: 'off', path: 'app.manifest.json' });
      expect(await child.resolve(ManifestSchemaSource).Load()).to.deep.equal([]);
    });

    it('loads the prepared schemas of the effective manifest', async () => {
      const child = DI.child({ isolateSingletons: true });
      registerManifest(child, manifest);
      registerManifestSettings(child, { mode: 'prefer', path: 'app.manifest.json' });
      const loaded = await child.resolve(ManifestSchemaSource).Load();
      expect(loaded.map((s) => s.schema.$id)).to.include(manifestSchemaKey('spinajs/app/Item'));
    });

    it('lets DataValidator validate against them by manifestSchemaKey', async () => {
      const child = DI.child({ isolateSingletons: true });
      child.register(QuietConfiguration).as(Configuration);
      // The configuration source decides the switch while Configuration resolves; the test decides it after.
      await child.resolve(Configuration);
      registerManifest(child, manifest);
      registerManifestSettings(child, { mode: 'prefer', path: 'app.manifest.json' });

      const validator = await child.resolve(DataValidator);
      expect(() => validator.validate(manifestSchemaKey('spinajs/app/Both'), { name: 'a', count: 1 })).to.not.throw();
      expect(() => validator.validate(manifestSchemaKey('spinajs/app/Both'), { name: 'a', count: 1, extra: true })).to.throw(ValidationFailed);
    });
  });
});
