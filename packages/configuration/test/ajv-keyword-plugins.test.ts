import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import Ajv from 'ajv';
import { DI, IContainer } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { configurationOf, NoSource } from './fixtures.js';
import { InvalidConfiguration } from '../src/exception.js';
import { addKeywordPluginsOnUse } from '../src/ajv-plugins.js';
import { registerConfigurationSchema } from '../src/schemas.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const PLAIN = {
  $id: 'test-plugins-plain',
  $configurationModule: 'plainPlugins',
  type: 'object',
  properties: { port: { type: 'integer', minimum: 1, default: 80 } },
};

const UNIQUE_NAMES = {
  $id: 'test-plugins-unique',
  $configurationModule: 'uniquePlugins',
  type: 'object',
  properties: { targets: { type: 'array', items: { type: 'object' }, uniqueItemProperties: ['name'] } },
};

const MERGED = {
  $id: 'test-plugins-merged',
  $configurationModule: 'mergedPlugins',
  $merge: {
    source: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    with: { properties: { port: { type: 'integer', maximum: 100 } } },
  },
};

const pluginKeywords = ['$merge', '$patch', 'uniqueItemProperties', 'typeof', 'instanceof', 'range', 'regexp', 'transform', 'select'];

type AjvClass = { prototype: { addKeyword: (this: unknown, def: unknown) => unknown } };
const AjvConstructor = ((Ajv as unknown as { default?: AjvClass }).default ?? Ajv) as unknown as AjvClass;

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
  const failure = (await boot(values, ...schemas).then(
    () => undefined,
    (e: unknown) => e,
  )) as InvalidConfiguration | undefined;
  expect(failure).to.be.instanceOf(InvalidConfiguration);
  return failure!.violations.map((v) => v.path);
}

describe('ajv-merge-patch and ajv-keywords are installed on first use', () => {
  let added: sinon.SinonSpy;

  beforeEach(() => {
    added = sinon.spy(AjvConstructor.prototype, 'addKeyword');
  });

  afterEach(async () => {
    sinon.restore();
    for (const c of booted.splice(0).reverse()) await c.dispose();
  });

  const pluginInstalls = () => added.getCalls().filter((c) => pluginKeywords.includes((c.args[0] as { keyword?: string })?.keyword ?? '')).length;

  it('boots without them when no schema names one of their keywords', async () => {
    const { config } = await boot({}, PLAIN);
    expect(config.get('plainPlugins.port')).to.equal(80);
    expect(pluginInstalls()).to.equal(0);
  });

  it('installs them for a schema that uses an ajv-keywords keyword, and still reports its violations', async () => {
    expect(await violationsOf({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'a' }] } }, PLAIN, UNIQUE_NAMES)).to.deep.equal(['uniquePlugins.targets']);
    expect(pluginInstalls()).to.be.greaterThan(0);
  });

  it('accepts a value that satisfies an ajv-keywords keyword', async () => {
    const { config } = await boot({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'b' }] } }, UNIQUE_NAMES);
    expect(config.get('uniquePlugins.targets')).to.have.length(2);
  });

  it('applies a $merge schema', async () => {
    expect(await violationsOf({ mergedPlugins: { host: 'h', port: 101 } }, MERGED)).to.include('mergedPlugins.port');
    expect(await violationsOf({ mergedPlugins: { port: 1 } }, MERGED)).to.include('mergedPlugins.host');
    const { config } = await boot({ mergedPlugins: { host: 'h', port: 100 } }, MERGED);
    expect(config.get('mergedPlugins.port')).to.equal(100);
  });

  it('installs them for a schema registered after the boot', async () => {
    const { child, config } = await boot({ uniquePlugins: { targets: [{ name: 'a' }, { name: 'a' }] } }, PLAIN);
    expect(pluginInstalls()).to.equal(0);
    expect(() => registerConfigurationSchema(UNIQUE_NAMES, child)).to.throw(InvalidConfiguration, /uniquePlugins\.targets/);
    expect(config.get('plainPlugins.port')).to.equal(80);
  });
});

describe('addKeywordPluginsOnUse', () => {
  type Validate = (data: unknown) => boolean;
  type Instance = {
    addSchema(s: object): unknown;
    validate(key: string, data: unknown): boolean;
    compile(s: object): Validate;
    compileAsync(s: object): Promise<Validate>;
    getKeyword(k: string): unknown;
    addKeyword(def: object | string): unknown;
    removeKeyword(k: string): unknown;
    addVocabulary(defs: object[]): unknown;
  };
  const NewAjv = AjvConstructor as unknown as new (o: object) => Instance;
  const ajv = (options: object = {}) => addKeywordPluginsOnUse(new NewAjv({ allErrors: true, ...options }));

  const duplicates = [{ id: 1 }, { id: 1 }];
  const ownRange = { keyword: 'range', type: 'number', schemaType: 'array', validate: (r: number[], v: number) => v === r[0] };
  const uniqueIds = { keyword: 'uniqueIds', macro: () => ({ uniqueItemProperties: ['id'] }) };

  afterEach(() => sinon.restore());

  it('installs the plugins once, for compile and addSchema alike', () => {
    const a = ajv();
    a.addSchema({ $id: 'unique', type: 'array', uniqueItemProperties: ['id'] });
    expect(a.validate('unique', [{ id: 1 }, { id: 1 }])).to.equal(false);
    expect(a.compile({ type: 'number', range: [1, 2] })(3)).to.equal(false);
  });

  it('finds a keyword nested anywhere in the schema', () => {
    const a = ajv();
    const validate = a.compile({ type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { tags: { type: 'array', uniqueItemProperties: ['k'] } } } } } });
    expect(validate({ list: [{ tags: [{ k: 1 }, { k: 1 }] }] })).to.equal(false);
    expect(validate({ list: [{ tags: [{ k: 1 }, { k: 2 }] }] })).to.equal(true);
  });

  it('leaves a schema without their keywords to the plain instance', () => {
    const a = ajv();
    expect(a.compile({ type: 'object', properties: { port: { type: 'number' } } })({ port: 'x' })).to.equal(false);
    expect(a.getKeyword('uniqueItemProperties')).to.equal(false);
  });

  // Without `strict`, Ajv ignores a keyword it does not know: a plugin keyword missing from the instance is a rule dropped silently.
  describe('without Ajv strict mode', () => {
    it('lets user code replace a plugin keyword, as with an eager install', () => {
      const a = ajv({ strict: false });
      a.removeKeyword('range');
      a.addKeyword(ownRange);

      expect(a.compile({ type: 'number', range: [1, 2] })(2)).to.equal(false);
      expect(a.compile({ type: 'number', range: [1, 2] })(1)).to.equal(true);
      expect(a.compile({ type: 'array', uniqueItemProperties: ['id'] })(duplicates)).to.equal(false);
    });

    it('installs the plugins before a macro keyword that may expand into theirs', () => {
      const a = ajv({ strict: false });
      a.addKeyword(uniqueIds);
      expect(a.compile({ type: 'array', uniqueIds: true })(duplicates)).to.equal(false);
    });

    it('installs the plugins before a vocabulary', () => {
      const a = ajv({ strict: false });
      a.addVocabulary([uniqueIds]);
      expect(a.compile({ type: 'array', uniqueIds: true })(duplicates)).to.equal(false);
    });

    it('installs the plugins for a macro keyword given to the Ajv constructor', () => {
      const a = ajv({ strict: false, keywords: [uniqueIds] });
      expect(a.compile({ type: 'array', uniqueIds: true })(duplicates)).to.equal(false);
    });

    it('installs the plugins for a schema given to the Ajv constructor', () => {
      const a = ajv({ strict: false, schemas: [{ $id: 'ctor-unique', type: 'array', uniqueItemProperties: ['id'] }] });
      expect(a.validate('ctor-unique', duplicates)).to.equal(false);
    });

    it('installs the plugins for compileAsync', async () => {
      const a = ajv({ strict: false, loadSchema: () => Promise.reject(new Error('no remote schema')) });
      expect((await a.compileAsync({ type: 'array', uniqueItemProperties: ['id'] }))(duplicates)).to.equal(false);
    });

    it('keeps a plugin keyword the instance already defines and installs the others', () => {
      const a = ajv({ strict: false, keywords: [ownRange] });
      expect(a.compile({ type: 'number', range: [1, 2] })(2)).to.equal(false);
      expect(a.compile({ type: 'array', uniqueItemProperties: ['id'] })(duplicates)).to.equal(false);
    });

    it('retries an install that failed', () => {
      const original = AjvConstructor.prototype.addKeyword;
      let failing = true;
      sinon.stub(AjvConstructor.prototype, 'addKeyword').callsFake(function (this: unknown, def: unknown) {
        if (failing && (def as { keyword?: string })?.keyword === 'uniqueItemProperties') throw new Error('install failed');
        return original.call(this, def);
      });
      const a = ajv({ strict: false });
      const schema = { type: 'array', uniqueItemProperties: ['id'] };
      expect(() => a.compile(schema)).to.throw('install failed');

      failing = false;
      expect(a.compile(schema)(duplicates)).to.equal(false);
    });
  });

  it('does not install the plugins for an annotation keyword', () => {
    const a = ajv();
    a.addKeyword('x-annotation');
    a.addKeyword({ keyword: 'x-described', schemaType: 'string' });
    expect(a.getKeyword('uniqueItemProperties')).to.equal(false);
  });
});
