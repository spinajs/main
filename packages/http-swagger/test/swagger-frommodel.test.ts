import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

/**
 * Coverage for the path parameters the document emits, with orm-http's @FromModel
 * ( Type = 'FromDbModel' ) as the hard case.
 *
 * The decorator loads a model from the database using the key carried by the URL, but the
 * route metadata only knows the TypeScript ARGUMENT name, never the placeholder from the
 * path. Under the strict contract the argument no longer decides anything on its own: path
 * parameters are emitted from the URL TEMPLATE, and a declared argument only enriches the
 * placeholder it names ( through `paramField`, or by being called after it ). Anything else
 * throws - see swagger-path-params-strict.test.ts.
 */
describe('Swagger path parameters', function () {
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

  it('should name the parameter after the path placeholder', () => {
    const p = params('/frommodel/{id}', 'get');

    expect(p.map((x: any) => x.name)).to.deep.equal(['id']);
    expect(p[0].in).to.equal('path');
    expect(p[0].required).to.equal(true);
  });

  it('should describe the parameter with the primary key column type, not the model object', () => {
    const p = params('/frommodel/{id}', 'get');

    // SlideId is an int column - a path segment carrying a model object is nonsense
    expect(p[0].schema.type).to.equal('integer');
    expect(p[0].content, 'a key value must not be emitted as a JSON content parameter').to.equal(undefined);
  });

  it('should keep the JSDoc description written for the argument', () => {
    const p = params('/frommodel/{id}', 'get');
    expect(p[0].description).to.contain('The slide loaded from the database');
  });

  /**
   * Two placeholders, each declared by an argument named after it. Neither argument may
   * bleed into the other's placeholder: `owner` is a plain @Param() number, `id` is the
   * model key.
   */
  it('should bind each declared argument to the placeholder of its own name', () => {
    const p = params('/frommodel/scoped/{owner}/slides/{id}', 'get');
    const byName = (name: string) => p.find((x: any) => x.name === name);

    expect(p.map((x: any) => x.name).sort()).to.deep.equal(['id', 'owner']);
    expect(byName('owner').in).to.equal('path');
    // FromModelSlide.SlideId is an int - if the model key had landed on `owner`, this fails
    expect(byName('id').schema.type).to.equal('integer');
    // `owner` is the plain @Param() number, documented as the numeric-or-numeric-string
    // union http emits for those - not a model object and not the model key.
    expect(byName('owner').schema.anyOf, '`owner` is the plain @Param(), not the model key').to.not.be.undefined;
  });

  it('should honour paramField and read the key type from an introspected column when @Primary is absent', () => {
    const p = params('/frommodel/tickets/{ticket}', 'delete');

    expect(p.map((x: any) => x.name)).to.deep.equal(['ticket']);
    // FromModelTicket has no @Primary() - the key is known only from the column descriptor
    expect(p[0].schema.type).to.equal('string');
  });

  /**
   * The design consequence of `noUnusedParameters`: a route that needs `:year` in the URL
   * but never reads it CANNOT declare an argument for it - the compiler rejects the unused
   * argument, and the strict resolver rejects an underscore-prefixed one. So the template
   * is the source of truth: every placeholder is emitted, declared or not.
   */
  it('should emit a placeholder that no argument declares', () => {
    const p = params('/frommodel/archive/{year}/slides/{id}', 'get');
    const byName = (name: string) => p.find((x: any) => x.name === name);

    expect(p.map((x: any) => x.name).sort()).to.deep.equal(['id', 'year']);

    expect(byName('year').in).to.equal('path');
    expect(byName('year').required).to.equal(true);
    expect(byName('year').schema).to.deep.equal({ type: 'string' });
    expect(byName('year').description, 'nothing declares `year`, so there is nothing to describe it with').to.equal(undefined);

    // The declared one still carries its model key schema
    expect(byName('id').schema.type).to.equal('integer');
  });

  it('should emit path parameters in URL template order', () => {
    const p = params('/frommodel/archive/{year}/slides/{id}', 'get');
    expect(p.map((x: any) => x.name)).to.deep.equal(['year', 'id']);
  });

  /**
   * `name` + `in` is the identity of an OpenAPI parameter; two entries sharing it make the
   * document invalid and the second one is silently dropped by most generators. Asserted over
   * the WHOLE document so any future resolver change that collides two parameters fails here
   * rather than in a downstream client generator.
   */
  it('should never emit two parameters with the same name and location on one operation', () => {
    const duplicates: string[] = [];

    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(methods)) {
        const seen = new Set<string>();
        for (const param of op?.parameters ?? []) {
          const key = `${param.in}:${param.name}`;
          if (seen.has(key)) {
            duplicates.push(`${method.toUpperCase()} ${path} -> ${key}`);
          }
          seen.add(key);
        }
      }
    }

    expect(duplicates, 'duplicate (name, in) parameter pairs').to.deep.equal([]);
  });

  /**
   * Every documented path parameter must exist in the URL template - a generator builds
   * code for it verbatim. The check runs against the OpenAPI path key, which carries the
   * whole template ( including any placeholder declared in @BasePath ).
   */
  it('should only document path parameters that the URL template actually contains', () => {
    const orphans: string[] = [];

    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      const placeholders = new Set((path.match(/{([^}]+)}/g) ?? []).map((x) => x.slice(1, -1)));
      for (const [method, op] of Object.entries<any>(methods)) {
        for (const param of op?.parameters ?? []) {
          if (param.in === 'path' && !placeholders.has(param.name)) {
            orphans.push(`${method.toUpperCase()} ${path} -> ${param.name}`);
          }
        }
      }
    }

    expect(orphans, 'path parameters that the URL template does not contain').to.deep.equal([]);
  });

  /**
   * The mirror of the rule above: a placeholder the template carries must be documented,
   * or a generated client cannot build the URL at all.
   */
  it('should document every placeholder the URL template contains', () => {
    const missing: string[] = [];

    for (const [path, methods] of Object.entries<any>(spec.paths)) {
      const placeholders = (path.match(/{([^}]+)}/g) ?? []).map((x) => x.slice(1, -1));
      for (const [method, op] of Object.entries<any>(methods)) {
        const documented = new Set((op?.parameters ?? []).filter((x: any) => x.in === 'path').map((x: any) => x.name));
        for (const placeholder of placeholders) {
          if (!documented.has(placeholder)) {
            missing.push(`${method.toUpperCase()} ${path} -> ${placeholder}`);
          }
        }
      }
    }

    expect(missing, 'URL placeholders with no documented path parameter').to.deep.equal([]);
  });

  it('should still place a non-default paramType in the query, with a primitive schema', () => {
    const p = params('/frommodel/by-query', 'get');

    expect(p).to.have.length(1);
    expect(p[0].in).to.equal('query');
    expect(p[0].required).to.equal(false);
    expect(p[0].schema.type).to.equal('integer');
  });

  /**
   * FromDbModel._extractValue reads `req.query[paramField ?? Name]`, so the documented
   * query key is the paramField when one is given - the argument name is not what the
   * runtime looks for.
   */
  it('should name a query-bound @FromModel after its paramField', () => {
    const p = params('/frommodel/by-query', 'get');
    expect(p[0].name).to.equal('slideId');
  });
});
