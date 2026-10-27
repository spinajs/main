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

describe('schema derivation: ORM models', () => {
  const { controller, diagnostics } = extract('models');

  it('derives a model to its declared columns and relations', () => {
    expect(controller.routes[0].returnType).to.deep.equal({ text: 'Author', schema: 'spinajs/fw/Author' });
    expect(registered('Author')).to.deep.equal({
      $id: 'spinajs/fw/Author',
      type: 'object',
      properties: { Id: { type: 'number' }, Name: { type: 'string' }, Books: { type: 'array', items: { $ref: 'spinajs/fw/Book' } } },
      required: ['Id', 'Name'],
      additionalProperties: false,
    });
    expect(registered('Book')).to.deep.equal({
      $id: 'spinajs/fw/Book',
      type: 'object',
      properties: { Id: { type: 'number' }, Title: { type: 'string' }, Author: { $ref: 'spinajs/fw/Author' } },
      required: ['Id'],
      additionalProperties: false,
    });
  });
  it('derives the dehydrated data of a model as the model', () => {
    const route = controller.routes.find((r) => r.handler === 'dehydrated')!;
    expect(registered('AuthorsController_dehydrated_Response')).to.deep.equal({
      $id: 'spinajs/fw/AuthorsController_dehydrated_Response',
      type: 'array',
      items: { $ref: 'spinajs/fw/Author' },
    });
    expect(route.returnType.schema).to.equal('spinajs/fw/AuthorsController_dehydrated_Response');
  });
  it('derives a model from a declaration file to an open object, never to its columns', () => {
    expect(registered('Shelf')).to.deep.equal({ $id: 'spinajs/fw/Shelf', type: 'object' });
    expect(JSON.stringify(registeredIds().map(registered))).not.to.include('Password');
  });
  it('derives a model extending a declaration-file model to an open object', () => {
    const route = controller.routes.find((r) => r.handler === 'localShelf')!;
    expect(route.returnType).to.deep.equal({ text: 'LocalShelf', schema: 'spinajs/fw/LocalShelf' });
    expect(registered('LocalShelf')).to.deep.equal({ $id: 'spinajs/fw/LocalShelf', type: 'object' });
  });
  it('reports each declaration-file model as SCH001 info and nothing from ModelBase internals', () => {
    expect(diagnostics.map((d) => [d.code, d.severity])).to.deep.equal([
      ['SCH001', 'info'],
      ['SCH001', 'info'],
    ]);
    expect(diagnostics[0].message).to.match(/^model Shelf is read from a declaration file/);
    expect(diagnostics[1].message).to.match(/^model LocalShelf extends Shelf, read from a declaration file/);
    expect(diagnostics.every((d) => d.message.includes('@Hidden'))).to.equal(true);
  });
});
