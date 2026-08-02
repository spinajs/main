import 'mocha';
import { expect } from 'chai';
import { ParameterType } from '@spinajs/http';
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
  // `_extractValue` is protected - reach it without dragging in DI/HTTP.
  const extract = (param: any, req: any) => (FromDbModel.prototype as any)._extractValue.call({}, param, req);

  const req = (params: Record<string, unknown>) => ({ params, query: {}, headers: {}, body: null });

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

  it('does not guess when the route carries more than one placeholder', () => {
    // Ambiguous: loading the wrong row is worse than failing. Such routes must
    // name the placeholder with paramField.
    expect(extract({ Name: 'entry', Options: {} }, req({ owner: '1', id: '7' }))).to.equal(undefined);
  });

  it('leaves a matching name alone even when other placeholders exist', () => {
    expect(extract({ Name: 'ticket', Options: {} }, req({ thread: '1', ticket: 'abc' }))).to.equal('abc');
  });

  it('does not apply the path fallback to non-path parameter types', () => {
    const param = { Name: 'slide', Options: { paramType: ParameterType.FromQuery } };
    expect(extract(param, { params: { id: '7' }, query: {}, headers: {}, body: null })).to.equal(undefined);
  });
});
