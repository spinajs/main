import { expect } from 'chai';
import { extract, registered, registeredIds } from './framework-harness.js';

describe('schema derivation: injected route params', () => {
  const { controller, diagnostics } = extract('injected');
  const params = controller.routes[0].params;

  it('records Req, Res and FromDi params with a type text and no schema', () => {
    expect(params.map((p) => [p.kind, p.runtimeType.schema])).to.deep.equal([
      ['Req', undefined],
      ['Res', undefined],
      ['FromDi', undefined],
      ['FromParams', 'spinajs/fw/InjectedController_read_id'],
    ]);
    expect(params[0].runtimeType.text).to.equal('Request');
    expect(params[2].runtimeType.text).to.equal('Configuration');
    expect(registered('InjectedController_read_id')).to.deep.equal({ $id: 'spinajs/fw/InjectedController_read_id', type: 'string' });
  });
  it('derives nothing from the injected types', () => {
    expect(diagnostics).to.deep.equal([]);
    expect(registeredIds().filter((id) => /Request|Response|Configuration/.test(id))).to.deep.equal([]);
  });
});
