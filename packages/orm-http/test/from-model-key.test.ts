import 'mocha';
import { expect } from 'chai';
import { IRoute, IRouteParameter, ParameterType } from '@spinajs/http';
import { FromDbModel } from '../src/index.js';

/**
 * Unit coverage for the key FromDbModel reads out of the request.
 *
 * The route-level suite in orm-http.test.ts cannot boot in every environment
 * ( its `before all` needs an fs provider ), and every route it declares happens
 * to name the placeholder after the argument - `@Get(':model') (@FromModel() model)`.
 * Real applications write `@Get(':id') getSlide(@FromModel() slide: Slide)`, where
 * the two differ, so the regression had no coverage at all. This exercises
 * `_extractValue` directly, with no HTTP server involved.
 */
describe('FromDbModel key extraction', () => {
  /**
   * `_extractValue` is protected - reach it through a prototype-only instance, with no DI
   * and no HTTP server.
   *
   * Skipping the constructor is safe because key extraction touches no injected state: it
   * reads `param`, `req`, `route` and - only to report a guess - `this.Log`, which is stubbed
   * here. `Container` / `Orm` are used by the QUERY side ( fromDbModelDefaultQueryFunction ),
   * which this suite does not call. If extraction ever starts reading them, this helper has
   * to hand it a fully resolved instance instead.
   */
  const warnings: string[] = [];
  // @Logger installs a DI-resolving getter on the prototype - shadow it with a plain stub.
  const self = Object.defineProperty(Object.create(FromDbModel.prototype), 'Log', { value: { warn: (msg: string) => warnings.push(msg) } });
  const extract = (param: any, req: any, route?: any) => (FromDbModel.prototype as any)._extractValue.call(self, param, req, route);

  const req = (params: Record<string, unknown>) => ({ params, query: {}, headers: {}, body: null });

  /**
   * Minimal IRoute stand-in. `Path` is the route-level template ( no @BasePath, exactly what
   * @spinajs/http stores and what http-swagger reads ), `Parameters` is keyed by argument index.
   */
  const route = (path: string, params: Partial<IRouteParameter>[]) =>
    ({
      Path: path,
      Parameters: new Map(params.map((p, i) => [i, { Index: i, Type: ParameterType.FromParams, Options: {}, ...p } as IRouteParameter])),
    }) as unknown as IRoute;

  beforeEach(() => (warnings.length = 0));

  it('reads the value under the declared parameter name', () => {
    expect(extract({ Name: 'model', Options: {} }, req({ model: '7' }))).to.equal('7');
  });

  it('falls back to the only placeholder when the argument name differs', () => {
    // @Get(':id') getSlide(@FromModel() slide: Slide)
    expect(extract({ Name: 'slide', Options: {} }, req({ id: '7' })), 'the :id placeholder was not used as the key').to.equal('7');
  });

  it('prefers an explicit paramField over the fallback', () => {
    expect(extract({ Name: 'slide', Options: { paramField: 'ticket' } }, req({ ticket: 'abc', id: '7' }))).to.equal('abc');
  });

  it('does not guess when the route carries more than one placeholder and the route is unknown', () => {
    // No IRoute ( a caller that never passed one ): ambiguous, and loading the wrong row is
    // worse than failing. With the route in hand the rule below applies instead.
    expect(extract({ Name: 'entry', Options: {} }, req({ owner: '1', id: '7' }))).to.equal(undefined);
  });

  it('leaves a matching name alone even when other placeholders exist', () => {
    expect(extract({ Name: 'ticket', Options: {} }, req({ thread: '1', ticket: 'abc' }))).to.equal('abc');
  });

  it('does not apply the path fallback to non-path parameter types', () => {
    const param = { Name: 'slide', Options: { paramType: ParameterType.FromQuery } };
    expect(extract(param, { params: { id: '7' }, query: {}, headers: {}, body: null })).to.equal(undefined);
  });

  /**
   * Same rule as the documentation side ( http-swagger OpenApiBuilder.resolveFromDbModelPathNames ):
   * paramField, then the argument name, then the first placeholder no other parameter names.
   * The spec said `:id` was the key while the runtime declined to guess and queried with null -
   * the doc looked right and the failure hid at runtime.
   */
  describe('with the route in hand', () => {
    it('takes the first placeholder no other parameter names', () => {
      // @Get('scoped/:owner/slides/:id') f(@Param() owner, @FromModel() entry)
      const r = route('scoped/:owner/slides/:id', [{ Name: 'owner' }, { Name: 'entry', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 1, Name: 'entry', Options: {} }, req({ owner: '1', id: '7' }), r), 'the free :id placeholder was not used as the key').to.equal('7');
    });

    it('honours the underscore alias when reserving placeholders for other parameters', () => {
      // @Get('rooms/:room/seats/:seat') f(@Param() _room, @FromModel() item)
      const r = route('rooms/:room/seats/:seat', [{ Name: '_room' }, { Name: 'item', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 1, Name: 'item', Options: {} }, req({ room: '1', seat: 'abc' }), r), '`_room` did not reserve the :room placeholder').to.equal('abc');
    });

    it('assigns placeholders to several @FromModel arguments in argument order', () => {
      const r = route('a/:first/b/:second', [
        { Name: 'one', Type: 'FromDbModel' as any },
        { Name: 'two', Type: 'FromDbModel' as any },
      ]);
      const request = req({ first: '1', second: '2' });

      expect(extract({ Index: 0, Name: 'one', Options: {} }, request, r)).to.equal('1');
      expect(extract({ Index: 1, Name: 'two', Options: {} }, request, r)).to.equal('2');
    });

    it('never steals a placeholder another @FromModel names outright', () => {
      // `ticket` matches by name, so the positional pass must not hand it :thread
      const r = route('threads/:thread/tickets/:ticket', [{ Name: '_thread' }, { Name: 'ticket', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 1, Name: 'ticket', Options: {} }, req({ thread: '1', ticket: 'abc' }), r)).to.equal('abc');
    });

    it('declines - and warns - when every placeholder already belongs to somebody', () => {
      const r = route('scoped/:owner', [{ Name: 'owner' }, { Name: 'entry', Type: 'FromDbModel' as any }]);

      expect(extract({ Index: 1, Name: 'entry', Options: {} }, req({ owner: '1' }), r)).to.equal(undefined);
      expect(warnings.join('\n'), 'an unresolvable model key must be reported').to.contain('entry');
    });

    /**
     * A guessed key must leave a trace - but once per route, not once per request: this sits
     * on a hot path and the message describes the code, which does not change between calls.
     * ( Hence the route path unique to this test: the dedupe is process-wide. )
     */
    it('warns once per route when it had to fall back rather than read the declared name', () => {
      const r = route('warned/:owner/slides/:id', [{ Name: 'owner' }, { Name: 'entry', Type: 'FromDbModel' as any }]);
      const param = { Index: 1, Name: 'entry', Options: {} };

      extract(param, req({ owner: '1', id: '7' }), r);
      extract(param, req({ owner: '2', id: '8' }), r);

      expect(warnings.join('\n'), 'a guessed key must leave a trace').to.contain(':id');
      expect(warnings, 'the warning repeated per request instead of per route').to.have.length(1);
    });
  });
});
