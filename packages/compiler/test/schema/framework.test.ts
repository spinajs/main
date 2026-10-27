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
    expect(registeredIds().filter((id) => /^spinajs\/fw\/(Request|Response|Configuration)(_|$)/.test(id))).to.deep.equal([]);
  });
});

describe('schema derivation: http responses', () => {
  const { controller, diagnostics } = extract('responses');
  const route = (handler: string) => controller.routes.find((r) => r.handler === handler)!;

  it('treats the abstract Response as a bare wrapper', () => {
    expect(route('helper').returnType).to.deep.equal({ text: 'Response' });
  });
  it('treats a union of responses as a bare wrapper', () => {
    expect(route('either').returnType).to.deep.equal({ text: 'Unauthorized | Ok' });
  });
  it('unwraps a Response subclass to its payload type', () => {
    expect(route('forbidden').returnType).to.deep.equal({ text: 'Greeting', schema: 'spinajs/fw/Greeting' });
  });
  it('unwraps a Response subclass without type parameters through its base', () => {
    expect(route('buffer').returnType).to.deep.equal({ text: 'Buffer<ArrayBufferLike>', schema: 'spinajs/fw/ResponsesController_buffer_Response' });
    expect(registered('ResponsesController_buffer_Response')).to.deep.equal({ $id: 'spinajs/fw/ResponsesController_buffer_Response', type: 'string', format: 'binary' });
  });
  it('reports nothing from Response internals', () => {
    expect(diagnostics).to.deep.equal([]);
  });
});
