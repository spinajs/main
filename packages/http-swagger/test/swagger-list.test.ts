import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

type Schema = { $ref?: string; type?: string; required?: string[]; enum?: string[]; const?: string; properties?: Record<string, Schema>; items?: Schema & { anyOf?: Schema[] } };
type Param = { name: string; in: string; required?: boolean; description?: string; schema: Schema };

describe('Swagger: orm-http list parameters and response', function () {
  this.timeout(30000);

  let spec: { paths: Record<string, { get: { parameters: Param[]; responses: Record<string, { content: Record<string, { schema: Schema }> }> } }>; components: { schemas: Record<string, Schema> } };

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
    await server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text) as typeof spec;
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.stop();
    DI.clearCache();
  });

  const operation = () => spec.paths['/list/orders'].get;
  const parameter = (name: string) => operation().parameters.find((p) => p.name === name)!;
  const resolve = (schema: Schema): Schema => (schema.$ref ? spec.components.schemas[schema.$ref.split('/').pop()!] : schema);

  // A registered parameter type is emitted with `schema`, not `content` ( registeredParameter in openapi-builder.ts ).
  it('documents aggregate as an optional JSON query parameter', () => {
    const aggregate = parameter('aggregate');
    expect(aggregate.in).to.equal('query');
    expect(aggregate.required ?? false).to.equal(false);
    expect(aggregate.description).to.contain('Group columns');
    expect(aggregate.schema).to.be.an('object');
  });

  it('names the groupable columns and the functions each column allows', () => {
    const schema = parameter('aggregate').schema;
    expect(schema.properties!.groupBy.items!.enum).to.have.members(['status', 'customerId']);

    const measures = schema.properties!.measures.items!.anyOf!;
    const amount = measures.find((m) => m.properties!.column?.const === 'amount' || m.properties!.column?.enum?.[0] === 'amount')!;
    expect(amount.properties!.fn.enum).to.have.members(['sum', 'avg']);
  });

  it('documents include as a query parameter listing the includable relations', () => {
    const include = parameter('include');
    expect(include.in).to.equal('query');
    expect(include.required ?? false).to.equal(false);
    expect(JSON.stringify(include.schema)).to.contain('customer');
  });

  it('describes the response as rows, total and aggregates', () => {
    const schema = resolve(operation().responses['200'].content['application/json'].schema);
    expect(schema.required).to.include.members(['rows', 'total']);
    expect(schema.properties!.rows.type).to.equal('array');
    expect(resolve(schema.properties!.rows.items!).properties).to.have.property('status');
    expect(schema.properties).to.have.property('aggregates');
  });
});
