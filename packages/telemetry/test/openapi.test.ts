import 'mocha';
import { expect } from 'chai';

import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';

// Side-effect import so the SwaggerService / OpenApiBuilder module graph is the
// same one the scanned SwaggerController below binds to.
import '@spinajs/http-swagger';

import { TestConfiguration, req, TEST_TOKEN } from './common.js';

// Importing the DTO barrel runs the `@Schema` decorators. That is the ONLY thing
// that puts the response schemas into the '__schemas__' DI map, which is what
// `DtoSchemaProvider` reads when the builder expands a `@returns {StatsResponse}`
// tag into a `#/components/schemas/...` component.
import './../src/dto/index.js';

/**
 * `docs/swagger.json` is served by http-swagger's own `SwaggerController`, which
 * is found the same way every other controller is — by reflection's file scan of
 * the `system.dirs.controllers` list. Importing the package does NOT mount it.
 *
 * That directory is declared in `common.ts` for EVERY suite rather than only
 * here, because reflection's `@ListFromFiles` memoizes the scanned controller
 * list for the life of the process: whichever suite boots first fixes the list,
 * so a directory this file added would never be scanned in a whole-suite run and
 * `docs/swagger.json` would 404.
 */

/**
 * `@Schema` stores the '__schemas__' map in the DI *cache*, so ANY
 * `DI.clearCache()` after the decorators ran drops the container's reference to
 * it — and every sibling suite in this package calls `clearCache()` in its
 * hooks. The decorators cannot be made to run a second time either: ESM caches
 * the module, so re-importing the barrel is a no-op.
 *
 * The Map object itself survives ( only the container's reference to it is
 * dropped ), so it is captured here at module load — the moment right after the
 * decorators ran — and put back into the fresh container in `before()`. Without
 * this, `DtoSchemaProvider` resolves nothing, every `@returns` silently degrades
 * to an untyped `object`, and the assertions below would fail for a reason that
 * has nothing to do with the controllers' JSDoc.
 */
const SCHEMAS = DI.get<Map<string, object>>('__schemas__');

/**
 * The prometheus endpoint is documented under `/metrics/`, with a trailing
 * slash, while the server mounts it at `/metrics`.
 *
 * PRE-EXISTING, and not a telemetry defect: for a route declared `@Get( '/' )`,
 * `packages/http/src/controllers.ts` builds the express path as `/${BasePath}`
 * while `packages/http-swagger/src/openapi-builder.ts` ( `buildPath` ) builds
 * the document key as `/${basePath}/`. Every controller in the monorepo with a
 * root route is documented that way — http-swagger's own tests assert `/pets/`
 * and `/rbac/` — so it is the builder's established output, not something this
 * controller can influence.
 *
 * It is cosmetic rather than broken: express is not in strict-routing mode, so
 * the documented URL resolves to the same handler. The `is actually served`
 * test below proves that instead of taking it on trust.
 */
const METRICS_PATH = '/metrics/';

const TELEMETRY_PATHS = [METRICS_PATH, '/telemetry/stats', '/telemetry/timeline', '/telemetry/routes', '/telemetry/perf', '/telemetry/health', '/telemetry/ready'];

/** the endpoints behind `TelemetryTokenPolicy` — see the `telemetry.auth.policies` block in common.ts */
const GUARDED_PATHS = [METRICS_PATH, '/telemetry/stats', '/telemetry/timeline', '/telemetry/routes', '/telemetry/perf'];

describe('telemetry openapi document', function () {
  this.timeout(30000);

  let doc: any;

  before(async () => {
    DI.clearCache();

    expect(SCHEMAS, "the '__schemas__' map must have been captured at module load").to.not.be.undefined;
    for (const [name, schema] of SCHEMAS!) {
      DI.register(schema).asMapValue('__schemas__', name);
    }

    DI.register(TestConfiguration).as(Configuration);
    DI.setESMModuleSupport();

    // The fs providers must exist before Controllers resolves — the controller
    // cache, the swagger cache and the response templates all read through them.
    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();

    // Fetched over HTTP rather than built through SwaggerService by hand: that is
    // the path a real consumer takes, and it covers the controller cache and the
    // JSDoc extraction end to end.
    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();

    expect(result, 'docs/swagger.json must be served').to.have.status(200);
    doc = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  const op = (path: string) => {
    expect(doc.paths[path], `${path} is missing from the document`).to.not.be.undefined;
    expect(doc.paths[path].get, `${path} has no GET operation`).to.not.be.undefined;
    return doc.paths[path].get;
  };

  it('documents every telemetry path', () => {
    for (const path of TELEMETRY_PATHS) {
      op(path);
    }
  });

  it('documents paths that are actually served', async () => {
    // The document is only worth anything if its keys are real URLs. Nothing in
    // the builder checks that — it composes the path from decorator metadata by
    // its own rules, which are NOT the rules the express mount uses.
    for (const path of TELEMETRY_PATHS) {
      const res = await req().get(path.replace(/^\//, '')).set('Accept', 'application/json').set('x-metrics-token', TEST_TOKEN);

      // A denied request still proves the route exists; an unmounted one does not.
      expect(res.status, `${path} must be routed`).to.not.eq(404);
      expect(JSON.stringify(res.body ?? {}), `${path} must be routed`).to.not.contain('Route not found');
    }
  });

  it('references a real component schema for each json response', () => {
    const expected: Record<string, string> = {
      '/telemetry/stats': 'StatsResponse',
      '/telemetry/timeline': 'TimelineResponse',
      '/telemetry/routes': 'RoutesResponse',
      '/telemetry/perf': 'PerfResponse',
      '/telemetry/health': 'HealthResponse',
      '/telemetry/ready': 'ReadyResponse',
    };

    for (const [path, name] of Object.entries(expected)) {
      const schema = op(path).responses['200'].content['application/json'].schema;

      // An unresolvable `@returns {Name}` does not fail the build — it silently
      // degrades to `{ type: 'object', description: 'Name' }`. Asserting the
      // `$ref` — and that what it points at is a populated component — is the
      // only thing standing between a typo and an untyped document.
      expect(schema.$ref, `${path} should $ref ${name}`).to.eq(`#/components/schemas/${name}`);
      expect(doc.components.schemas[name], `${name} component is missing`).to.not.be.undefined;
      expect(doc.components.schemas[name].type, `${name}.type`).to.eq('object');
      expect(Object.keys(doc.components.schemas[name].properties ?? {}), `${name} has no properties`).to.not.have.length(0);
    }
  });

  it('documents the buckets query parameter', () => {
    const params = op('/telemetry/timeline').parameters ?? [];
    const buckets = params.find((p: any) => p.name === 'buckets');

    expect(buckets, 'the buckets query parameter must be documented').to.not.be.undefined;
    expect(buckets.in).to.eq('query');
    expect(buckets.required, 'buckets is optional — omitting it means "all buckets"').to.eq(false);

    // STRING, matching the handler signature. `buckets` is taken as a string and
    // parsed in `getTimeline` because declaring it `number` hands validation to
    // ajv, which rejects `Number( 'abc' )` -> NaN with a generic message instead
    // of this endpoint's own "buckets must be a positive integer".
    //
    // The document is therefore WEAKER than the contract — it does not say the
    // value has to be a positive integer, only that it is a string. Asserted as
    // it actually is rather than as it ought to be: making the tag claim
    // `{number}` would document a coercion the endpoint does not perform.
    expect(buckets.schema.type, 'buckets is declared as a string and parsed in the handler').to.eq('string');

    // so the JSDoc @param text is what has to carry the real constraint
    expect(buckets.description, 'buckets must carry its JSDoc description').to.be.a('string').and.to.not.be.empty;
  });

  it('documents the 503 on readiness and the 403 on the guarded endpoints', () => {
    const ready = op('/telemetry/ready').responses['503'];

    // 503 is not in the builder's reusable-component set, so it is emitted
    // inline — the description IS the whole documentation of that response.
    expect(ready, '/telemetry/ready must document a 503').to.not.be.undefined;
    expect(ready.description, 'the 503 must say why it happens').to.be.a('string').and.to.not.be.empty;

    for (const path of GUARDED_PATHS) {
      const forbidden = op(path).responses['403'];

      expect(forbidden, `${path} must document a 403`).to.not.be.undefined;
      expect(forbidden.$ref, `${path} 403 should $ref the shared Forbidden response`).to.eq('#/components/responses/Forbidden');
    }

    expect(doc.components.responses?.Forbidden, 'the Forbidden response component must exist').to.not.be.undefined;
  });

  it('documents the 400 the timeline endpoint raises for a bad bucket count', () => {
    const badRequest = op('/telemetry/timeline').responses['400'];

    expect(badRequest, '/telemetry/timeline must document a 400').to.not.be.undefined;
    expect(badRequest.$ref).to.eq('#/components/responses/BadRequest');
    expect(doc.components.responses?.BadRequest, 'the BadRequest response component must exist').to.not.be.undefined;
  });

  it('leaves the unguarded probes free of a 403', () => {
    // health and ready run under PublicPolicy — a documented 403 there would be
    // a lie, and would tell an uptime monitor to expect an auth failure
    for (const path of ['/telemetry/health', '/telemetry/ready']) {
      expect(op(path).responses['403'], `${path} must not document a 403`).to.be.undefined;
    }
  });
});
