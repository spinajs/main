import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { FrameworkLogger, renderTemplate } from '@spinajs/log';
import { TestConfiguration, dir, req, srcDir } from './common.js';
import '../src/index.js';

const RATE_LIMIT_HEADERS = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];

// Only what the assertions read, typed as present: an absent field is what some of them check.
interface ISchemaDoc {
  type: string;
  required: string[];
  enum: unknown[];
  properties: Record<string, ISchemaDoc>;
}

interface IResponseDoc {
  $ref: string;
  description: string;
  headers: Record<string, { schema: ISchemaDoc }>;
  content: Record<string, { schema: ISchemaDoc }>;
}

type OperationDoc = { responses: Record<string, IResponseDoc>; deprecated?: boolean; parameters?: unknown[]; requestBody?: unknown } & Record<`x-${string}`, unknown>;

interface ISpecDoc {
  paths: Record<string, Record<string, OperationDoc>>;
  components: { responses: Record<string, IResponseDoc> };
}

class RateLimitedConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('system.dirs.controllers', [dir('./support/rate-limited'), srcDir('./controllers')]);
  }
}

describe('Swagger middleware responses', function () {
  this.timeout(30000);

  let spec: ISpecDoc;
  let warnings: string[];
  const op = (route: string) => spec.paths[`/limits/${route}`].post;

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(RateLimitedConfiguration).as(Configuration);

    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.start();

    const warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text) as ISpecDoc;
    // only the `(fields, template)` form names its fields; the builder warns in that form
    warnings = warn
      .getCalls()
      .flatMap(({ args: [fields, template] }) => (typeof template === 'string' && typeof fields === 'object' ? [renderTemplate(template, fields as Record<string, unknown>)] : []));
    warn.restore();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.stop();
    DI.clearCache();
  });

  it('refs the shared TooManyRequests answer of a quiet limit', () => {
    const { responses } = op('limited');
    expect(responses['429']).to.deep.equal({ $ref: '#/components/responses/TooManyRequests' });
    expect(responses['200'].headers).to.be.undefined;
    expect(op('limited')['x-rate-limit']).to.be.undefined;

    const component = spec.components.responses.TooManyRequests;
    expect(component.description).to.equal('Too many requests');
    expect(Object.keys(component.headers)).to.deep.equal(['Retry-After']);
    expect(component.headers['Retry-After'].schema).to.deep.equal({ type: 'integer' });
    expect(component.content['application/json'].schema.properties.error.properties.code.enum).to.deep.equal(['E_TOO_MANY_REQUESTS']);
  });

  it('renders the 429 of a limit that sends X-RateLimit-* inline, with those headers on the success answer', () => {
    const operation = op('loud');
    const tooMany = operation.responses['429'];
    expect(tooMany.$ref).to.be.undefined;
    expect(Object.keys(tooMany.headers)).to.have.members(['Retry-After', ...RATE_LIMIT_HEADERS]);
    expect(tooMany.content['application/json'].schema.required).to.deep.equal(['error']);
    expect(Object.keys(operation.responses['200'].headers)).to.have.members(RATE_LIMIT_HEADERS);
    expect(operation['x-rate-limit']).to.deep.equal([{ limit: 5, windowSeconds: 60, by: 'ip' }]);
  });

  it('documents no 429 on a route declared unlimited', () => {
    expect(op('off').responses['429']).to.be.undefined;
  });

  it('keeps the 429 the JSDoc documents', () => {
    const tooMany = op('documented').responses['429'];
    expect(tooMany.$ref).to.be.undefined;
    expect(tooMany.description).to.equal('custom');
  });

  it('documents nothing for an unmarked custom answer', () => {
    expect(Object.keys(op('custom').responses)).to.deep.equal(['200']);
  });

  it('documents a marked custom answer under its own status', () => {
    const { responses } = op('marked');
    expect(responses['429']).to.be.undefined;
    expect(responses['503'].description).to.equal('Busy, come back later');
    expect(Object.keys(responses['503'].headers)).to.deep.equal(['Retry-After']);
    expect(responses['503'].content).to.be.undefined;
  });

  it('leaves `by` out of x-rate-limit for a custom key', () => {
    expect(op('keyed')['x-rate-limit']).to.deep.equal([{ limit: 5, windowSeconds: 60 }]);
  });

  it('adds the success headers to a typed success answer and keeps its content', () => {
    const ok = spec.paths['/limits/typed'].get.responses['200'];
    expect(ok.content['application/json'].schema).to.deep.equal({ type: 'string' });
    expect(Object.keys(ok.headers)).to.have.members(RATE_LIMIT_HEADERS);
  });

  it('documents a route inherited from a base controller', () => {
    expect(op('inherited').responses['429']).to.deep.equal({ $ref: '#/components/responses/TooManyRequests' });
  });

  it("lets the route's own limit answer over the controller's, and lists only the limit that sends headers", () => {
    const operation = spec.paths['/class-limits/narrowed'].post;
    expect(operation.responses['429'].description).to.equal('Route limit hit');
    expect(Object.keys(operation.responses['429'].headers)).to.deep.equal(['Retry-After']);
    expect(operation['x-rate-limit']).to.deep.equal([{ limit: 100, windowSeconds: 60, by: 'ip' }]);
    expect(Object.keys(operation.responses['200'].headers)).to.have.members(RATE_LIMIT_HEADERS);
  });

  it("keeps the controller's 429 when the route's own answer is unmarked", () => {
    const tooMany = spec.paths['/class-limits/unmarkedOwn'].post.responses['429'];
    expect(tooMany.description).to.equal('Too many requests');
    expect(Object.keys(tooMany.headers)).to.have.members(['Retry-After', ...RATE_LIMIT_HEADERS]);
  });

  it('lists the x-rate-limit entries of both limits when both send headers, the controller one first', () => {
    const operation = spec.paths['/class-limits/bothLoud'].post;
    expect(operation['x-rate-limit']).to.deep.equal([
      { limit: 100, windowSeconds: 60, by: 'ip' },
      { limit: 5, windowSeconds: 60, by: 'ip' },
    ]);
  });

  it('keeps the 403 of @Access over a middleware answer on the same status', () => {
    const { responses } = spec.paths['/guarded/overlapping'].post;
    expect(responses['403']).to.deep.equal({ $ref: '#/components/responses/Forbidden' });
    expect(responses['401']).to.deep.equal({ $ref: '#/components/responses/Unauthorized' });
    expect(responses['423'].description).to.equal('Locked');
  });

  it('keeps the x-authz-domain of @Access when a middleware sends the same extension', () => {
    const operation = spec.paths['/guarded/overlapping'].post;
    expect(operation['x-authz-domain']).to.equal('tenant');
    expect(operation['x-guarded']).to.equal(true);
  });

  it("documents the controller's limit on a route without its own", () => {
    const operation = spec.paths['/class-limits/wide'].post;
    expect(Object.keys(operation.responses['429'].headers)).to.have.members(['Retry-After', ...RATE_LIMIT_HEADERS]);
    expect(operation['x-rate-limit']).to.deep.equal([{ limit: 100, windowSeconds: 60, by: 'ip' }]);
  });

  it('merges only the x- keys of what a middleware hands over as extensions', () => {
    const operation = spec.paths['/misdocumented/operationKeys'].post;
    expect(operation['x-kept']).to.equal(true);
    expect(operation.deprecated).to.be.undefined;
    expect(operation.parameters).to.be.undefined;
    expect(operation.requestBody).to.be.undefined;
  });

  it('skips a middleware whose documentation() throws, with a warning, and documents the others', () => {
    expect(spec.paths['/misdocumented/throwing'].post.responses['423'].description).to.equal('Locked');
    const warning = warnings.find((w) => w.includes('ThrowingDocMiddleware'));
    expect(warning).to.include('POST /misdocumented/throwing');
  });
});
