import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType } from '@spinajs/http';
import { FromDbModel } from '../src/index.js';

/**
 * The url parameter a @FromModel reads is stated, never guessed.
 *
 * It resolves in exactly two ways: `paramField` names it, or the argument is called after
 * it. Anything else throws - there is no positional assignment, no "the only parameter
 * present", no underscore aliasing. A route the runtime cannot read unambiguously is a
 * route to fix, and the same rule decides what the OpenAPI document says, so a route that
 * serves traffic and a route that can be documented are the same set.
 *
 * Exercised through `_extractValue` directly: the route-level suite in orm-http.test.ts
 * cannot boot in every environment ( its `before all` needs an fs provider ), and every
 * route it declares happens to name the placeholder after the argument.
 */
describe('FromDbModel key extraction', () => {
  /**
   * `_extractValue` is protected - reach it through a prototype-only instance, with no DI
   * and no HTTP server. Skipping the constructor is safe because key extraction touches no
   * injected state: it reads `param`, `req` and `route` only. `Container` / `Orm` belong to
   * the QUERY side ( fromDbModelDefaultQueryFunction ), which this suite never calls.
   */
  const self = Object.create(FromDbModel.prototype);
  const extract = (param: any, req: any, route?: any) => (FromDbModel.prototype as any)._extractValue.call(self, param, req, route);

  const req = (params: Record<string, unknown>) => ({ params, query: {}, headers: {}, body: null });

  /**
   * Minimal IRoute stand-in. `Path` is the route-level template ( no @BasePath, exactly what
   * @spinajs/http stores ), `Parameters` is keyed by argument index.
   */
  const route = (path: string, params: Partial<IRouteParameter>[]) =>
    ({
      Path: path,
      Parameters: new Map(params.map((p, i) => [i, { Index: i, Type: ParameterType.FromParams, Options: {}, ...p } as IRouteParameter])),
    }) as unknown as IRoute;

  describe('resolves', () => {
    it('reads the value under the declared argument name', () => {
      expect(extract({ Name: 'model', Options: {} }, req({ model: '7' }))).to.equal('7');
    });

    it('reads the value under an explicit paramField', () => {
      // @Get(':id') getSlide(@FromModel({ paramField: 'id' }) slide: Slide)
      expect(extract({ Name: 'slide', Options: { paramField: 'id' } }, req({ id: '7' }))).to.equal('7');
    });

    it('prefers paramField over an argument name that also matches', () => {
      expect(extract({ Name: 'slide', Options: { paramField: 'ticket' } }, req({ ticket: 'abc', slide: '7' }))).to.equal('abc');
    });

    it('reads its own parameter when the route carries several', () => {
      const r = route('scoped/:owner/slides/:id', [{ Name: 'owner' }, { Name: 'entry', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 1, Name: 'entry', Options: { paramField: 'id' } }, req({ owner: '1', id: '7' }), r)).to.equal('7');
    });

    /**
     * A placeholder declared in @BasePath never appears in `route.Path`, but it does arrive
     * in `req.params` - which is why the check is against the request, not the template.
     */
    it('accepts a parameter the route template does not mention', () => {
      const r = route('slides/:id', [{ Name: 'tenant', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 0, Name: 'tenant', Options: {} }, req({ tenant: 'acme', id: '7' }), r)).to.equal('acme');
    });

    it('reads an empty string rather than treating it as absent', () => {
      expect(extract({ Name: 'model', Options: {} }, req({ model: '' }))).to.equal('');
    });
  });

  describe('throws', () => {
    const message = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as Error).message;
      }
      return undefined;
    };

    it('when the argument name matches no url parameter', () => {
      // @Get(':id') getSlide(@FromModel() slide: Slide) - the old code guessed :id
      const msg = message(() => extract({ Name: 'slide', Options: {} }, req({ id: '7' })));

      expect(msg, 'an unresolvable key was guessed instead of reported').to.not.be.undefined;
      expect(msg).to.contain('slide');
      expect(msg, 'the message must list what the request really carries').to.contain('id');
      expect(msg, 'the message must state the fix').to.contain('paramField');
    });

    it('when paramField names a url parameter that is not there', () => {
      const msg = message(() => extract({ Name: 'slide', Options: { paramField: 'nope' } }, req({ id: '7' })));

      expect(msg).to.contain('nope');
    });

    it('when an underscore-prefixed argument would once have aliased a placeholder', () => {
      // `_thread` used to resolve to :thread; an argument nobody reads is deleted instead
      const msg = message(() => extract({ Name: '_thread', Options: {} }, req({ thread: '1' })));

      expect(msg, 'the underscore alias is gone and must not resolve').to.not.be.undefined;
      expect(msg).to.contain('_thread');
    });

    it('when the route carries exactly one parameter under another name', () => {
      // the old "only one parameter present, so it must be that one" heuristic
      const msg = message(() => extract({ Name: 'entry', Options: {} }, req({ id: '7' })));

      expect(msg, 'the single-parameter heuristic is gone and must not resolve').to.not.be.undefined;
    });

    it('when the route carries several parameters and none matches', () => {
      const r = route('scoped/:owner/slides/:id', [{ Name: 'owner' }, { Name: 'entry', Type: 'FromDbModel' as any }]);
      const msg = message(() => extract({ Index: 1, Name: 'entry', Options: {} }, req({ owner: '1', id: '7' }), r));

      expect(msg).to.contain('entry');
      expect(msg, 'the route path helps locate the offender').to.contain('scoped/:owner/slides/:id');
    });

    it('when the request carries no url parameters at all', () => {
      const msg = message(() => extract({ Name: 'model', Options: {} }, req({})));

      expect(msg).to.contain('(none)');
    });
  });

  describe('non-path parameter types are untouched', () => {
    it('reads a query key without consulting url parameters', () => {
      const param = { Name: 'slide', Options: { paramType: ParameterType.FromQuery, paramField: 'slideId' } };

      expect(extract(param, { params: { id: '7' }, query: { slideId: '9' }, headers: {}, body: null })).to.equal('9');
    });

    it('does not throw for a query key that is absent', () => {
      const param = { Name: 'slide', Options: { paramType: ParameterType.FromQuery } };

      expect(extract(param, { params: {}, query: {}, headers: {}, body: null })).to.equal(undefined);
    });
  });
});
