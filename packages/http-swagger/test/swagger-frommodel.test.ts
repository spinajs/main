import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

/**
 * Regression coverage for orm-http's @FromModel ( Type = 'FromDbModel' ) path params.
 *
 * The decorator loads a model from the database using the key carried by the URL,
 * but the route metadata only knows the TypeScript ARGUMENT name ( `slide` ), never
 * the placeholder from the path ( `:id` ). Emitting the argument name produced a
 * parameter that does not exist in the URL template, plus `type: object` from the
 * model schema - every OpenAPI client generator then built code referring to a
 * parameter the path never had. The name must be the placeholder and the schema
 * must be the key column's primitive type.
 */
describe('Swagger @FromModel path parameters', function () {
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

  const params = (path: string, method: string) => {
    const op = spec.paths[path]?.[method];
    expect(op, `no ${method.toUpperCase()} operation for ${path}`).to.not.be.undefined;
    return op.parameters ?? [];
  };

  it('should name the parameter after the path placeholder, not after the argument', () => {
    const p = params('/frommodel/{id}', 'get');

    expect(p.map((x: any) => x.name), 'expected the :id placeholder, not the `slide` argument name').to.deep.equal(['id']);
    expect(p[0].in).to.equal('path');
    expect(p[0].required).to.equal(true);
  });

  it('should describe the parameter with the primary key column type, not the model object', () => {
    const p = params('/frommodel/{id}', 'get');

    // SlideId is an int column - a path segment carrying a model object is nonsense
    expect(p[0].schema.type).to.equal('integer');
    expect(p[0].content, 'a key value must not be emitted as a JSON content parameter').to.equal(undefined);
  });

  it('should keep the JSDoc description written for the argument name', () => {
    const p = params('/frommodel/{id}', 'get');
    expect(p[0].description).to.contain('The slide loaded from the database');
  });

  it('should not steal a placeholder already taken by a plain @Param()', () => {
    const p = params('/frommodel/scoped/{owner}/slides/{id}', 'get');
    const byName = (name: string) => p.find((x: any) => x.name === name);

    expect(p.map((x: any) => x.name).sort()).to.deep.equal(['id', 'owner']);
    expect(byName('owner').in).to.equal('path');
    expect(byName('id').schema.type).to.equal('integer');
  });

  it('should keep an argument name that already is a placeholder, even when it is not the first one', () => {
    const p = params('/frommodel/threads/{thread}/tickets/{ticket}', 'get');
    const byName = (name: string) => p.find((x: any) => x.name === name);

    // `ticket` matches a placeholder by name, so it must not be reassigned to the
    // first free one — that would hand it `thread` and lose the real parameter.
    // `thread` is present, but it belongs to the underscore-prefixed @Param()
    // ( see the underscore alias test below ), NOT to the @FromModel argument:
    // the model key is a varchar, a plain @Param() number is not.
    expect(p.map((x: any) => x.name).sort()).to.deep.equal(['thread', 'ticket']);
    // FromModelTicket.Uuid is a varchar - if the @FromModel param had grabbed `thread`
    // instead, the varchar key would be sitting on the wrong placeholder.
    expect(byName('ticket').schema.type, 'the @FromModel param grabbed a placeholder that is not its own').to.equal('string');
    // `thread` is a plain @Param() number, documented as the numeric-or-numeric-string
    // union http emits for those - not a model object.
    expect(byName('thread').schema.type).to.equal(undefined);
    expect(byName('thread').schema.anyOf).to.not.be.undefined;
  });

  /**
   * `@spinajs/http` names a route parameter after the TypeScript argument, and an
   * argument is often prefixed with `_` purely to satisfy `noUnusedParameters` — the
   * route needs `:thread` in the URL without reading it. FromParams.extract() already
   * honours that at RUNTIME ( it falls back to the name without the leading `_` ), so
   * emitting `_thread` documented a parameter the URL template never contains.
   */
  it('should emit the placeholder for an underscore-prefixed @Param() argument', () => {
    const p = params('/frommodel/threads/{thread}/tickets/{ticket}', 'get');
    const names = p.map((x: any) => x.name);

    expect(names, 'the `_` prefix leaked into the documented parameter name').to.not.include('_thread');
    expect(names).to.include('thread');
  });

  it('should honour paramField and read the key type from an introspected column when @Primary is absent', () => {
    const p = params('/frommodel/tickets/{ticket}', 'delete');

    expect(p.map((x: any) => x.name)).to.deep.equal(['ticket']);
    // FromModelTicket has no @Primary() - the key is known only from the column descriptor
    expect(p[0].schema.type).to.equal('string');
  });

  it('should still place a non-default paramType in the query, with a primitive schema', () => {
    const p = params('/frommodel/by-query', 'get');

    expect(p).to.have.length(1);
    expect(p[0].in).to.equal('query');
    expect(p[0].required).to.equal(false);
    expect(p[0].schema.type).to.equal('integer');
  });
});
