import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

/**
 * Regression coverage for the filter envelope built from an orm model descriptor.
 *
 * http-swagger reads that descriptor through the global `Symbol.for('MODEL_DESCRIPTOR')`
 * rather than depending on @spinajs/orm. That coupling is invisible to the type
 * system, so when orm moved from a name-keyed metadata container to identity-keyed
 * own metadata, the read silently returned nothing and every operator disappeared
 * from the docs without a single test going red. These tests pin the shape.
 */
describe('Swagger filter envelope from orm model descriptor', function () {
  this.timeout(30000);

  let spec: any;

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  const filterParam = () => {
    const op = spec.paths['/filter/pets'].get;
    return op.parameters.find((p: any) => p.in === 'query');
  };

  // An object-typed query parameter is emitted as `content['application/json']`
  // rather than `schema` ( buildParameter ), since OpenAPI cannot express a
  // structured query value with a bare schema.
  const filterSchema = () => filterParam().content['application/json'].schema;

  it('should document the @Filter parameter as a query parameter', () => {
    const op = spec.paths['/filter/pets'].get;
    expect(op.parameters).to.be.an('array');
    expect(filterParam(), 'no query parameter emitted for @Filter').to.not.be.undefined;
  });

  it('should build the { op, filters } envelope rather than the generic fallback', () => {
    const schema = filterSchema();

    expect(schema.type).to.equal('object');
    expect(schema.required).to.deep.equal(['op', 'filters']);
    expect(schema.properties.op.enum).to.deep.equal(['and', 'or']);
    expect(schema.properties.filters.type).to.equal('array');

    // The generic fallback carries a description and NO properties - reaching it
    // means extractFilterableColumns returned []
    expect(schema.description).to.equal(undefined);
  });

  it('should emit one filter variant per @Filterable column of the model', () => {
    const variants = filterSchema().properties.filters.items.oneOf;

    expect(variants, 'expected a oneOf per filterable column').to.be.an('array').with.length(2);
    expect(variants.map((v: any) => v.properties.Column.enum[0])).to.deep.equal(['name', 'age']);
  });

  it('should carry each column\'s operators through to its Operator enum', () => {
    const variants = filterSchema().properties.filters.items.oneOf;
    const byColumn = (name: string) => variants.find((v: any) => v.properties.Column.enum[0] === name);

    expect(byColumn('name').properties.Operator.enum).to.deep.equal(['eq', 'like']);
    expect(byColumn('age').properties.Operator.enum).to.deep.equal(['gt', 'lt', 'eq']);
  });
});
