import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, RouteType } from '@spinajs/http';
// The builder module alone, not the index: the registration must come with it.
import { OpenApiBuilder } from '../src/openapi-builder.js';

type AddedController = Parameters<OpenApiBuilder['addController']>[0];

interface JsonParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

describe('Swagger @KeysetQuery()', function () {
  function listOperation(): { parameters: JsonParameter[] } {
    const page = { Index: 0, Type: 'KeysetQueryRouteArg', Name: 'page', RuntimeType: Object, Options: {} } as IRouteParameter;
    const route = { Path: '', Type: RouteType.GET, InternalType: RouteType.GET, Method: 'list', Parameters: new Map([[0, page]]), Middlewares: [], Policies: [], Options: {}, Schema: null } as unknown as IRoute;
    const controller = { name: 'OrdersController', instance: { Descriptor: { BasePath: 'orders', Routes: new Map([['list', route]]), Policies: [] } } } as unknown as AddedController;
    const builder = new OpenApiBuilder({ enabled: true, title: 't', version: '1' });
    builder.addController(controller, { className: 'OrdersController', methods: { list: { params: {} } } });

    const item = Object.values(builder.build().paths)[0];
    return JSON.parse(JSON.stringify(Object.values(item)[0])) as { parameters: JsonParameter[] };
  }

  it('documents limit, after and before as optional query parameters', () => {
    const op = listOperation();

    expect(op.parameters.map((p) => [p.name, p.in, p.required])).to.deep.equal([
      ['limit', 'query', false],
      ['after', 'query', false],
      ['before', 'query', false],
    ]);
    // the server clamps a larger limit instead of refusing it, so the schema states no maximum
    expect(op.parameters[0].schema).to.deep.equal({ type: 'integer', minimum: 1 });
    expect(op.parameters[0].description).to.eq('Rows per page; default 50, clamped to 500');
  });
});
