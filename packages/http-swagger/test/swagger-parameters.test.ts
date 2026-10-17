import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import { OpenApiBuilder } from '../src/openapi-builder.js';
import { IMethodDocumentation, ISwaggerConfig } from '../src/interfaces.js';

describe('Swagger parameters, bodies and paths', function () {
  function param(Index: number, Type: string, Name: string, Options?: unknown): IRouteParameter {
    return { Index, Type, Name, Options, RuntimeType: String } as IRouteParameter;
  }

  function build(opts: { path?: string; type?: RouteType; params?: IRouteParameter[]; doc?: Partial<IMethodDocumentation>; config?: Partial<ISwaggerConfig> }) {
    const route = {
      Path: opts.path ?? 'items',
      Type: opts.type ?? RouteType.GET,
      InternalType: opts.type ?? RouteType.GET,
      Method: 'handler',
      Parameters: new Map((opts.params ?? []).map((p) => [p.Index, p])),
      Middlewares: [],
      Policies: [],
      Options: {},
      Schema: null,
    } as unknown as IRoute;

    const controller = { name: 'ItemsController', instance: { Descriptor: { BasePath: 'items', Routes: new Map([['handler', route]]), Policies: [] } } } as any;
    const builder = new OpenApiBuilder({ enabled: true, title: 't', version: '1', ...opts.config });
    builder.addController(controller, { className: 'ItemsController', methods: { handler: { params: {}, ...opts.doc } } });
    return builder.build();
  }

  const operation = (spec: any) => Object.values(spec.paths)[0] as any;

  it('documents @Header(keyName) under the key it reads and carries { required: true }', () => {
    const spec = build({ params: [param(0, ParameterType.FromHeader, 'tenant', { key: 'x-tenant', required: true }), param(1, ParameterType.FromQuery, 'page', { required: true })] });
    const [header, query] = operation(spec).get.parameters;

    expect(header).to.include({ name: 'x-tenant', in: 'header', required: true });
    expect(query).to.include({ name: 'page', in: 'query', required: true });
  });

  it('documents @UserAgent() and @Referer() as header parameters', () => {
    const spec = build({ params: [param(0, ParameterType.UserAgent, 'ua'), param(1, ParameterType.Referer, 'ref')] });

    expect(operation(spec).get.parameters.map((p: any) => `${p.in}:${p.name}`)).to.deep.equal(['header:User-Agent', 'header:Referer']);
  });

  it('documents @FromXml() as an application/xml body and @RawBody() as a JSON body', () => {
    const xml = build({ type: RouteType.POST, params: [param(0, ParameterType.FromXml, 'doc')] });
    const raw = build({ type: RouteType.POST, params: [param(0, ParameterType.RawBody, 'raw')] });

    expect(operation(xml).post.requestBody.content).to.have.property('application/xml');
    expect(operation(raw).post.requestBody.content).to.have.property('application/json');
  });

  it('maps the JSDoc type integer to an integer schema', () => {
    const spec = build({ params: [param(0, ParameterType.FromQuery, 'page')], doc: { params: { page: { name: 'page', type: 'integer' } } } });

    expect(operation(spec).get.parameters[0].schema).to.deep.equal({ type: 'integer' });
  });

  it('attaches @example to a multipart request body', () => {
    const spec = build({ type: RouteType.POST, params: [param(0, ParameterType.FromFile, 'scan')], doc: { examples: [{ name: 'upload', value: '{"a":1}' }] } });

    expect(operation(spec).post.requestBody.content['multipart/form-data'].examples.upload.value).to.deep.equal({ a: 1 });
  });

  it('documents route "/" where the runtime mounts it and normalises slashes in basePath', () => {
    const spec = build({ path: '/', config: { basePath: '/api/' } });

    expect(Object.keys(spec.paths)).to.deep.equal(['/api/items']);
  });
});
