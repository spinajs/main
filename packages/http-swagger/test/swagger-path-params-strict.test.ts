import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType, RouteType } from '@spinajs/http';
import { OpenApiBuilder } from '../src/openapi-builder.js';
import { ISwaggerCacheEntry } from '../src/interfaces.js';

/**
 * The strict path-parameter contract.
 *
 * A route parameter that lives in the path resolves to a URL placeholder in exactly two
 * ways: `Options.paramField` names one, or the argument itself is called after one.
 * There is no positional assignment, no "first free placeholder", no underscore aliasing
 * and no silent pass-through - anything else throws while the spec is being built. A
 * controller the documentation layer cannot read unambiguously is a controller to fix,
 * not to guess at.
 *
 * These cases build the OpenApiBuilder DIRECTLY instead of adding fixtures under
 * `test/controllers`. That directory is loaded by every suite in the package, so a single
 * illegal route there would make the builder throw for unrelated suites too.
 */
describe('Swagger strict path parameter resolution', function () {
  const CONTROLLER = 'StrictController';

  function routeParam(partial: Partial<IRouteParameter> & { Index: number; Type: string; Name: string }): IRouteParameter {
    return {
      RuntimeType: Number,
      Options: undefined,
      ...partial,
    } as IRouteParameter;
  }

  /**
   * Build a one-route controller and hand it to a freshly constructed builder.
   * Returns the thunk so a test can assert either the throw or the emitted operation.
   */
  function buildRoute(opts: { path?: string; basePath?: string; method?: string; params: IRouteParameter[] }) {
    const method = opts.method ?? 'handler';
    const route: IRoute = {
      Path: opts.path,
      InternalType: RouteType.GET,
      Type: RouteType.GET,
      Method: method,
      Parameters: new Map(opts.params.map((p) => [p.Index, p])),
      Middlewares: [],
      Policies: [],
      Options: {},
      Schema: null,
    };

    const controller = {
      name: CONTROLLER,
      instance: {
        Descriptor: {
          BasePath: opts.basePath ?? 'strict',
          Routes: new Map<string, IRoute>([[method, route]]),
          Policies: [],
        },
      },
    } as any;

    const docCache: ISwaggerCacheEntry = { className: CONTROLLER, methods: {} };
    const builder = new OpenApiBuilder({ enabled: true, title: 'strict', version: '1.0.0' });

    return () => {
      builder.addController(controller, docCache);
      return builder.build();
    };
  }

  const pathParams = (spec: any, path: string) => (spec.paths[path].get.parameters ?? []).filter((x: any) => x.in === 'path');

  describe('illegal shapes', () => {
    it('should throw when a @FromModel argument name matches no placeholder', () => {
      const build = buildRoute({
        path: ':id',
        method: 'getSlide',
        params: [routeParam({ Index: 0, Type: 'FromDbModel', Name: 'slide' })],
      });

      expect(build).to.throw(/StrictController\.getSlide/);
      expect(build).to.throw(/path argument `slide` matches no placeholder/);
      expect(build).to.throw(/\/strict\/\{id\}/);
      expect(build).to.throw(/Available placeholders: id/);
      expect(build).to.throw(/paramField/);
    });

    it('should throw for an underscore-prefixed argument instead of aliasing it to the placeholder', () => {
      const build = buildRoute({
        path: ':campaign/comments/:comment',
        method: 'listComments',
        params: [
          routeParam({ Index: 0, Type: ParameterType.FromParams, Name: '_campaign' }),
          routeParam({ Index: 1, Type: ParameterType.FromParams, Name: 'comment' }),
        ],
      });

      expect(build).to.throw(/path argument `_campaign` matches no placeholder/);
      expect(build).to.throw(/Available placeholders: campaign, comment/);
    });

    it('should throw instead of handing a @FromModel the first free placeholder', () => {
      const build = buildRoute({
        path: 'scoped/:owner/slides/:id',
        method: 'getScopedSlide',
        params: [
          routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'owner' }),
          routeParam({ Index: 1, Type: 'FromDbModel', Name: 'entry' }),
        ],
      });

      expect(build).to.throw(/path argument `entry` matches no placeholder/);
      expect(build).to.throw(/Available placeholders: owner, id/);
    });

    it('should throw when paramField names a placeholder the route has not got', () => {
      const build = buildRoute({
        path: 'tickets/:ticket',
        method: 'deleteTicket',
        params: [routeParam({ Index: 0, Type: 'FromDbModel', Name: 'item', Options: { paramField: 'ticketId' } })],
      });

      expect(build).to.throw(/path argument `item` declares paramField `ticketId`/);
      expect(build).to.throw(/Available placeholders: ticket/);
    });

    it('should throw when the route has no placeholders at all', () => {
      const build = buildRoute({
        path: 'list',
        method: 'list',
        params: [routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'id' })],
      });

      expect(build).to.throw(/path argument `id` matches no placeholder/);
      expect(build).to.throw(/route declares no path placeholders/);
    });

    it('should throw when two arguments declare the same placeholder', () => {
      const build = buildRoute({
        path: 'slides/:id',
        method: 'getSlide',
        params: [
          routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'id' }),
          routeParam({ Index: 1, Type: 'FromDbModel', Name: 'slide', Options: { paramField: 'id' } }),
        ],
      });

      expect(build).to.throw(/placeholder `id` is declared twice/);
      expect(build).to.throw(/`id`.*`slide`|`slide`.*`id`/);
    });

    /**
     * The message is the whole feature: without the controller, the method, the argument,
     * the template and the way out, a developer gets a stack trace and a guess.
     */
    it('should state controller, method, argument, template, placeholders and the fix in one message', () => {
      const build = buildRoute({
        path: ':id',
        method: 'getSlide',
        params: [routeParam({ Index: 0, Type: 'FromDbModel', Name: 'slide' })],
      });

      let message = '';
      try {
        build();
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).to.contain('StrictController.getSlide');
      expect(message).to.contain('`slide`');
      expect(message).to.contain('/strict/{id}');
      expect(message).to.contain('Available placeholders: id');
      expect(message).to.contain("paramField: 'id'");
    });
  });

  describe('legal shapes', () => {
    it('should accept an argument whose name is a placeholder', () => {
      const spec = buildRoute({
        path: 'slides/:id',
        params: [routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'id' })],
      })();

      expect(pathParams(spec, '/strict/slides/{id}').map((x: any) => x.name)).to.deep.equal(['id']);
    });

    it('should accept an argument whose paramField is a placeholder, whatever the argument is called', () => {
      const spec = buildRoute({
        path: 'tickets/:ticket',
        params: [routeParam({ Index: 0, Type: 'FromDbModel', Name: 'item', Options: { paramField: 'ticket' } })],
      })();

      expect(pathParams(spec, '/strict/tickets/{ticket}').map((x: any) => x.name)).to.deep.equal(['ticket']);
    });

    /**
     * A @FromModel reading its key from the query string never touches the URL, so the
     * strict path rule has no business rejecting an argument name it does not use.
     */
    it('should not apply the path rule to a @FromModel that reads from the query', () => {
      const spec = buildRoute({
        path: 'search',
        params: [
          routeParam({
            Index: 0,
            Type: 'FromDbModel',
            Name: 'slide',
            Options: { paramType: ParameterType.FromQuery, paramField: 'slideId' },
          }),
        ],
      })();

      const all = spec.paths['/strict/search'].get.parameters ?? [];
      expect(all).to.have.length(1);
      expect(all[0].in).to.equal('query');
      expect(all[0].name).to.equal('slideId');
    });

    it('should emit an undeclared placeholder as a required string', () => {
      const spec = buildRoute({
        path: 'archive/:year/slides/:id',
        params: [routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'id' })],
      })();

      const p = pathParams(spec, '/strict/archive/{year}/slides/{id}');
      expect(p.map((x: any) => x.name)).to.deep.equal(['year', 'id']);

      const year = p.find((x: any) => x.name === 'year');
      expect(year.required).to.equal(true);
      expect(year.schema).to.deep.equal({ type: 'string' });
      expect(year.description).to.equal(undefined);
    });

    /**
     * A placeholder declared in @BasePath never reaches route.Path, so resolving against
     * the route path alone would reject a perfectly legal argument.
     */
    it('should see placeholders declared in @BasePath', () => {
      const spec = buildRoute({
        basePath: 'shops/:shop',
        path: 'slides/:id',
        params: [
          routeParam({ Index: 0, Type: ParameterType.FromParams, Name: 'shop' }),
          routeParam({ Index: 1, Type: ParameterType.FromParams, Name: 'id' }),
        ],
      })();

      expect(pathParams(spec, '/shops/{shop}/slides/{id}').map((x: any) => x.name)).to.deep.equal(['shop', 'id']);
    });
  });
});
