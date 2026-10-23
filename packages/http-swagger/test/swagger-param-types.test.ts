import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import * as swagger from '../src/index.js';
import { IMethodDocumentation, OpenApiBuilder, registerOpenApiParamType } from '../src/index.js';

/**
 * The registry is process-wide, so every type registered here has a `Test` prefix and is never
 * reused across tests. Built directly, like swagger-path-params-strict.test.ts: a fixture under
 * test/controllers is loaded by every HTTP suite.
 */
describe('Swagger custom route-arg types (registerOpenApiParamType)', function () {
  function param(Index: number, Type: string, Name: string, Options?: unknown): IRouteParameter {
    return { Index, Type, Name, Options, RuntimeType: String } as IRouteParameter;
  }

  interface BuildOptions {
    path?: string;
    type?: RouteType;
    params: IRouteParameter[];
    doc?: Partial<IMethodDocumentation>;
  }

  function builderFor(opts: BuildOptions) {
    const route = {
      Path: opts.path ?? 'items',
      Type: opts.type ?? RouteType.PUT,
      InternalType: opts.type ?? RouteType.PUT,
      Method: 'handler',
      Parameters: new Map(opts.params.map((p) => [p.Index, p])),
      Middlewares: [],
      Policies: [],
      Options: {},
      Schema: null,
    } as unknown as IRoute;

    const controller = { name: 'ItemsController', instance: { Descriptor: { BasePath: 'items', Routes: new Map([['handler', route]]), Policies: [] } } } as any;
    const builder = new OpenApiBuilder({ enabled: true, title: 't', version: '1' });

    return () => {
      builder.addController(controller, { className: 'ItemsController', methods: { handler: { params: {}, ...opts.doc } } });
      return builder.build();
    };
  }

  /** The route's only operation, as the JSON a client receives (undefined fields dropped). */
  function operation(opts: BuildOptions): any {
    const spec = builderFor(opts)();
    const item = Object.values(spec.paths)[0];
    return JSON.parse(JSON.stringify(Object.values(item)[0]));
  }

  before(() => {
    registerOpenApiParamType('TestHeaderArg', () => ({ in: 'header', schema: { type: 'string' } }));
    registerOpenApiParamType('TestTraceArg', () => ({ in: 'header', name: 'x-trace', required: true, description: 'Trace id', schema: { type: 'string', format: 'uuid' } }));
    registerOpenApiParamType('TestQueryArg', () => ({ in: 'query', schema: { type: 'integer' } }));
    registerOpenApiParamType('TestCookieArg', () => ({ in: 'cookie', name: 'sid', schema: { type: 'string' } }));
    registerOpenApiParamType('TestPathArg', () => ({ in: 'path', schema: { type: 'string', format: 'uuid' } }));
    registerOpenApiParamType('TestBodyArg', () => ({ in: 'body', contentType: 'application/octet-stream', schema: { type: 'string', format: 'binary' } }));
    registerOpenApiParamType('TestOptionalBodyArg', () => ({ in: 'body', contentType: 'text/plain', required: false, description: 'Free text', schema: { type: 'string' } }));
    registerOpenApiParamType('TestBodyAndHeaderArg', () => [
      { in: 'body', contentType: 'text/csv', schema: { type: 'string' } },
      { in: 'header', name: 'x-rows', schema: { type: 'integer' } },
    ]);
    registerOpenApiParamType('TestNothingArg', () => []);
    registerOpenApiParamType('TestOptionsArg', (p) => ({ in: 'query', required: (p.Options as { required?: boolean } | undefined)?.required === true, schema: { type: 'string' } }));
  });

  describe('parameters', () => {
    it('documents a registered header under the argument name, optional by default', () => {
      const op = operation({ params: [param(0, 'TestHeaderArg', 'tenant')] });

      expect(op.parameters).to.deep.equal([{ name: 'tenant', in: 'header', required: false, schema: { type: 'string' } }]);
    });

    it('takes name, required and description from the registration', () => {
      const op = operation({ params: [param(0, 'TestTraceArg', 'trace')] });

      expect(op.parameters).to.deep.equal([{ name: 'x-trace', in: 'header', required: true, description: 'Trace id', schema: { type: 'string', format: 'uuid' } }]);
    });

    it('lets the @param text win over the registered description', () => {
      const op = operation({ params: [param(0, 'TestTraceArg', 'trace')], doc: { params: { trace: { name: 'trace', description: 'Per-call trace' } } } });

      expect(op.parameters[0].description).to.equal('Per-call trace');
    });

    it('emits query and cookie parameters in argument order, after the path ones', () => {
      const op = operation({
        path: ':id',
        params: [param(0, 'TestQueryArg', 'page'), param(1, ParameterType.FromParams, 'id'), param(2, 'TestCookieArg', 'session')],
      });

      expect(op.parameters.map((p: any) => `${p.in}:${p.name}`)).to.deep.equal(['path:id', 'query:page', 'cookie:sid']);
      expect(op.parameters[1]).to.deep.equal({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } });
    });

    it("calls describe for every argument, with that argument's options", () => {
      const op = operation({ params: [param(0, 'TestOptionsArg', 'a', { required: true }), param(1, 'TestOptionsArg', 'b')] });

      expect(op.parameters.map((p: any) => [p.name, p.required])).to.deep.equal([
        ['a', true],
        ['b', false],
      ]);
    });
  });

  describe('path parameters', () => {
    it('binds a registered path description to the placeholder of the same name, in template order', () => {
      const op = operation({ path: ':upload/parts/:part', params: [param(0, 'TestPathArg', 'upload')] });

      expect(op.parameters).to.deep.equal([
        { name: 'upload', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'part', in: 'path', required: true, schema: { type: 'string' } },
      ]);
    });

    it('fails the build when the registered path parameter names no placeholder', () => {
      const build = builderFor({ path: ':id', params: [param(0, 'TestPathArg', 'upload')] });

      expect(build).to.throw(/ItemsController\.handler: argument `upload` \(TestPathArg\) describes path parameter `upload`/);
      expect(build).to.throw(/Available placeholders: id/);
    });

    it('fails the build when a registered and a native argument declare the same placeholder', () => {
      const build = builderFor({ path: ':upload', params: [param(0, ParameterType.FromParams, 'upload'), param(1, 'TestPathArg', 'upload')] });

      expect(build).to.throw(/placeholder `upload` is declared twice/);
    });
  });

  describe('request bodies', () => {
    it('turns a registered body into the request body', () => {
      const op = operation({ params: [param(0, 'TestBodyArg', 'blob')], doc: { params: { blob: { name: 'blob', description: 'Raw bytes' } } } });

      expect(op.requestBody).to.deep.equal({
        description: 'Raw bytes',
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      });
      expect(op).to.not.have.property('parameters');
    });

    it('keeps required: false and the registered description', () => {
      const op = operation({ params: [param(0, 'TestOptionalBodyArg', 'note')] });

      expect(op.requestBody).to.deep.equal({ description: 'Free text', required: false, content: { 'text/plain': { schema: { type: 'string' } } } });
    });

    it('puts the registered schema in verbatim, without named-type expansion', () => {
      registerOpenApiParamType('TestNamedSchemaArg', () => ({ in: 'body', contentType: 'application/json', schema: { type: 'object', description: 'Pet' } }));

      const spec = builderFor({ path: 'named', params: [param(0, 'TestNamedSchemaArg', 'pet')] })();
      const schema = JSON.parse(JSON.stringify(spec.paths['/items/named'].put.requestBody!.content['application/json'].schema));

      expect(schema).to.deep.equal({ type: 'object', description: 'Pet' });
      expect(spec.components).to.not.have.property('schemas');
    });

    it('wins over a @body tag', () => {
      const op = operation({ params: [param(0, 'TestBodyArg', 'blob')], doc: { body: { type: 'string' } } });

      expect(Object.keys(op.requestBody.content)).to.deep.equal(['application/octet-stream']);
    });

    it('documents a body and a header described by one argument', () => {
      const op = operation({ params: [param(0, 'TestBodyAndHeaderArg', 'rows')] });

      expect(op.requestBody).to.deep.equal({ required: true, content: { 'text/csv': { schema: { type: 'string' } } } });
      expect(op.parameters).to.deep.equal([{ name: 'x-rows', in: 'header', required: false, schema: { type: 'integer' } }]);
    });

    it('documents nothing for an empty description list', () => {
      const op = operation({ type: RouteType.POST, params: [param(0, 'TestNothingArg', 'x')] });

      expect(op).to.not.have.property('parameters');
      expect(op).to.not.have.property('requestBody');
    });

    it('refuses a registered body next to a parsed body argument', () => {
      const build = builderFor({ params: [param(0, 'TestBodyArg', 'blob'), param(1, ParameterType.FromBody, 'meta')] });

      expect(build).to.throw(/ItemsController\.handler: argument `blob` is the whole request body \(application\/octet-stream\)/);
      expect(build).to.throw(/`meta`/);
    });

    it('refuses a registered body next to a file', () => {
      const build = builderFor({ params: [param(0, 'TestBodyArg', 'blob'), param(1, ParameterType.FromFile, 'file')] });

      expect(build).to.throw(/argument `blob` is the whole request body/);
      expect(build).to.throw(/`file`/);
    });

    it('refuses two registered bodies', () => {
      const build = builderFor({ params: [param(0, 'TestBodyArg', 'a'), param(1, 'TestOptionalBodyArg', 'b')] });

      expect(build).to.throw(/argument `a` is the whole request body/);
      expect(build).to.throw(/`b`/);
    });
  });

  describe('registry', () => {
    it('copies the schema, so editing the document leaves the registration alone', () => {
      const shared = { type: 'object', properties: { a: { type: 'string' } } };
      registerOpenApiParamType('TestSharedSchemaArg', () => ({ in: 'body', contentType: 'application/json', schema: shared }));

      const spec = builderFor({ path: 'shared', params: [param(0, 'TestSharedSchemaArg', 'dto')] })();
      spec.paths['/items/shared'].put.requestBody!.content['application/json'].schema!.properties!.a.type = 'number';

      expect(shared.properties.a.type).to.equal('string');
    });

    it('replaces an earlier registration of the same type', () => {
      registerOpenApiParamType('TestReplacedArg', () => ({ in: 'query', schema: { type: 'string' } }));
      registerOpenApiParamType('TestReplacedArg', () => ({ in: 'header', schema: { type: 'string' } }));

      const op = operation({ params: [param(0, 'TestReplacedArg', 'x')] });

      expect(op.parameters.map((p: any) => p.in)).to.deep.equal(['header']);
    });

    it('never overrides a type the builder maps itself', () => {
      registerOpenApiParamType(ParameterType.FromQuery, () => ({ in: 'header', name: 'hijacked', schema: {} }));

      const op = operation({ params: [param(0, ParameterType.FromQuery, 'page')] });

      expect(op.parameters.map((p: any) => `${p.in}:${p.name}`)).to.deep.equal(['query:page']);
    });

    it('is exported from the package index, without the internal lookup', () => {
      expect(swagger.registerOpenApiParamType).to.be.a('function');
      expect(swagger).to.not.have.property('describeRegisteredParam');
    });
  });
});
