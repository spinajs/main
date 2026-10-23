import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
// The builder module alone, not the index: the registrations must come with it.
import { OpenApiBuilder } from '../src/openapi-builder.js';
import { IMethodDocumentation } from '../src/interfaces.js';

// What @spinajs/http's Parameter() sets for string and number arguments (http/src/schemas/RouteArgsSchemas.ts).
const STRING_ARG = { type: 'string', maxLength: 512 };
const NUMBER_ARG = { anyOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] };
const DIGEST_DESCRIPTION = 'RFC 9530 digest of the request body, e.g. `sha-256=:<base64>:`';
const OCTET_BODY = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };

interface JsonParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: unknown;
}

interface JsonOperation {
  parameters: JsonParameter[];
  requestBody?: { description?: string; required: boolean; content: Record<string, { schema: unknown }> };
}

type AddedController = Parameters<OpenApiBuilder['addController']>[0];

describe('Swagger @RequestStream() and @ContentDigest()', function () {
  function param(partial: Partial<IRouteParameter> & { Index: number; Type: string; Name: string }): IRouteParameter {
    return { RuntimeType: Object, Options: undefined, ...partial } as IRouteParameter;
  }

  const upload = param({ Index: 0, Type: ParameterType.FromParams, Name: 'upload', RuntimeType: String, RouteParamSchema: STRING_ARG });
  const part = param({ Index: 1, Type: ParameterType.FromParams, Name: 'part', RuntimeType: Number, RouteParamSchema: NUMBER_ARG });
  const stream = (Index: number, Options?: unknown) => param({ Index, Type: 'RequestStreamArg', Name: 'body', Options });
  const digest = (Index: number, Options?: unknown) => param({ Index, Type: 'ContentDigestArg', Name: 'digest', RuntimeType: Map, Options });

  function builderFor(params: IRouteParameter[], doc?: Partial<IMethodDocumentation>, path = ':upload/parts/:part') {
    const route = {
      Path: path,
      Type: RouteType.PUT,
      InternalType: RouteType.PUT,
      Method: 'putPart',
      Parameters: new Map(params.map((p) => [p.Index, p])),
      Middlewares: [],
      Policies: [],
      Options: {},
      Schema: null,
    } as unknown as IRoute;

    const controller = { name: 'UploadsController', instance: { Descriptor: { BasePath: 'uploads', Routes: new Map([['putPart', route]]), Policies: [] } } } as unknown as AddedController;
    const builder = new OpenApiBuilder({ enabled: true, title: 't', version: '1' });

    return () => {
      builder.addController(controller, { className: 'UploadsController', methods: { putPart: { params: {}, ...doc } } });
      return builder.build();
    };
  }

  function putPart(params: IRouteParameter[], doc?: Partial<IMethodDocumentation>): JsonOperation {
    const spec = builderFor(params, doc)();
    return JSON.parse(JSON.stringify(spec.paths['/uploads/{upload}/parts/{part}'].put)) as JsonOperation;
  }

  it('documents the part upload route exactly', () => {
    const op = putPart([upload, part, stream(2, { maxBytes: 8 * 1024 * 1024 }), digest(3, { required: true })]);

    expect(op.parameters).to.deep.equal([
      { name: 'upload', in: 'path', required: true, schema: STRING_ARG },
      { name: 'part', in: 'path', required: true, schema: NUMBER_ARG },
      { name: 'content-digest', in: 'header', required: true, description: DIGEST_DESCRIPTION, schema: { type: 'string' } },
    ]);
    expect(op.requestBody).to.deep.equal({ required: true, content: OCTET_BODY });
  });

  it('documents @ContentDigest() without required as an optional header', () => {
    for (const options of [undefined, {}, { required: false, algorithms: ['sha-256'] }]) {
      const op = putPart([upload, part, digest(2, options)]);

      expect(op.parameters[2], JSON.stringify(options)).to.deep.equal({ name: 'content-digest', in: 'header', required: false, description: DIGEST_DESCRIPTION, schema: { type: 'string' } });
    }
  });

  it('names the header content-digest whatever the argument is called', () => {
    const op = putPart([upload, part, param({ Index: 2, Type: 'ContentDigestArg', Name: 'partHash' })]);

    expect(op.parameters[2].name).to.equal('content-digest');
  });

  it('lets the @param text describe the stream body and the digest header', () => {
    const op = putPart([upload, part, stream(2), digest(3)], {
      params: { body: { name: 'body', description: 'Raw bytes of the part' }, digest: { name: 'digest', description: 'Digest of this part' } },
    });

    expect(op.requestBody).to.deep.equal({ description: 'Raw bytes of the part', required: true, content: OCTET_BODY });
    expect(op.parameters[2].description).to.equal('Digest of this part');
  });

  it('refuses @RequestStream() next to @Body()', () => {
    const build = builderFor([upload, part, stream(2), param({ Index: 3, Type: ParameterType.FromBody, Name: 'meta' })]);

    expect(build).to.throw(/UploadsController\.putPart: argument `body` is the whole request body \(application\/octet-stream\)/);
    expect(build).to.throw(/`meta`/);
  });
});
