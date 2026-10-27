import { expect } from 'chai';
import { extract, extractModelsOf, published, registered, registeredIds } from './framework-harness.js';

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
    expect(published()).not.to.include('Password');
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

describe('schema derivation: model columns', () => {
  const { diagnostics } = extract('columns');
  const note = extractModelsOf('columns').find((m) => m.className === 'Note')!;

  it('lists inherited and writable accessor columns, public members only, in the models section', () => {
    expect(note.columns.map((c) => c.name)).to.deep.equal(['Id', 'Secret', 'Body', 'CreatedAt']);
    expect(note.relations).to.deep.equal([{ name: 'Writer', kind: 'belongsTo', target: 'Author' }]);
  });
  it('derives the schema from the same columns, @Hidden ones left out, and the relations', () => {
    expect(registered('Note')).to.deep.equal({
      $id: 'spinajs/fw/Note',
      type: 'object',
      properties: { Id: { type: 'number' }, Writer: { $ref: 'spinajs/fw/Author' }, Body: { type: 'string' }, CreatedAt: { type: 'string', format: 'date-time' } },
      required: ['Id', 'Body', 'CreatedAt'],
      additionalProperties: false,
    });
    const listed = [...note.columns.filter((c) => c.name !== 'Secret').map((c) => c.name), ...note.relations.map((r) => r.name)];
    expect(Object.keys((registered('Note') as { properties: object }).properties).sort()).to.deep.equal(listed.sort());
    expect(diagnostics).to.deep.equal([]);
  });
  it('finds the target model of a relation class through its base', () => {
    expect((registered('Shelfmark') as { properties: unknown }).properties).to.deep.equal({ Id: { type: 'number' }, Picks: { type: 'array', items: { $ref: 'spinajs/fw/Book' } } });
  });
});

describe('schema derivation: types derived from a model', () => {
  const { controller, diagnostics } = extract('mapped');
  const route = (handler: string) => controller.routes.find((r) => r.handler === handler)!;
  const returned = (handler: string): unknown => {
    const { $id: _id, ...schema } = registered(route(handler).returnType.schema!.replace('spinajs/fw/', '')) as Record<string, unknown>;
    return schema;
  };
  const books = { type: 'array', items: { $ref: 'spinajs/fw/Book' } };
  const authorProperties = { Id: { type: 'number' }, Name: { type: 'string' }, Books: books };

  it('leaves the @Hidden columns of an in-program model out of Partial, Pick, Omit, Readonly and Required', () => {
    expect(returned('aPartial')).to.deep.equal({ type: 'object', properties: authorProperties, additionalProperties: false });
    expect(returned('aPick')).to.deep.equal({ type: 'object', properties: { Id: { type: 'number' } }, required: ['Id'], additionalProperties: false });
    expect(returned('aOmit')).to.deep.equal({ type: 'object', properties: { Id: { type: 'number' }, Books: books }, required: ['Id'], additionalProperties: false });
    expect(returned('aReadonly')).to.deep.equal({ type: 'object', properties: authorProperties, required: ['Id', 'Name'], additionalProperties: false });
    expect(returned('aRequired')).to.deep.equal({ type: 'object', properties: authorProperties, required: ['Id', 'Name'], additionalProperties: false });
  });
  it('leaves them out of Partial<ModelData<M>>, arrays of those, an interface extending the model and a request body', () => {
    expect(returned('aData')).to.deep.equal({ type: 'object', properties: { Id: { type: 'number' }, Name: { type: 'string' } }, additionalProperties: false });
    expect(returned('aArray')).to.deep.equal({ type: 'array', items: { type: 'object', properties: authorProperties, additionalProperties: false } });
    expect(registered('IAuthorView')).to.deep.equal({
      $id: 'spinajs/fw/IAuthorView',
      type: 'object',
      properties: { Shown: { type: 'boolean' }, ...authorProperties },
      required: ['Shown', 'Id', 'Name'],
      additionalProperties: false,
    });
    const body = registered(route('aBody').params[0].runtimeType.schema!.replace('spinajs/fw/', ''));
    expect(body).to.deep.include({ properties: authorProperties });
  });
  it('derives every type built from a declaration-file model to an open object', () => {
    for (const handler of ['sPartial', 'sPick', 'sOmit', 'sReadonly', 'sRequired', 'sData']) expect(returned(handler), handler).to.deep.equal({ type: 'object' });
    expect(returned('sArray')).to.deep.equal({ type: 'array', items: { type: 'object' } });
    expect(registered('IShelfView')).to.deep.equal({ $id: 'spinajs/fw/IShelfView', type: 'object' });
    expect((registered('Editorial') as { properties: unknown }).properties).to.deep.equal({ Id: { type: 'number' }, Shelf: { type: 'object' } });
  });
  it('publishes no hidden column and no ModelBase internal anywhere', () => {
    const all = published();
    for (const hidden of ['Password', 'Token', 'IDriverOptions', 'ModelDescriptor', 'Container']) expect(all, hidden).not.to.include(hidden);
  });
  it('reports each open object as SCH001 info naming the declaration-file model, and no warning', () => {
    expect(diagnostics.length).to.be.greaterThan(0);
    expect(diagnostics.filter((d) => d.severity !== 'info')).to.deep.equal([]);
    expect(diagnostics.every((d) => d.code === 'SCH001' && /model Shelf, read from a declaration file .*@Hidden/.test(d.message)), JSON.stringify(diagnostics)).to.equal(true);
  });
});

describe('schema derivation: types derived from the real @spinajs/users User', () => {
  const { controller, diagnostics } = extract('users');

  it('never publish Password, PasswordSetAt or a driver option', () => {
    const schemas = controller.routes.flatMap((r) => [r.returnType.schema, ...r.params.map((p) => p.runtimeType.schema)]);
    expect(schemas.every(Boolean)).to.equal(true);
    const all = published();
    for (const hidden of ['Password', 'PasswordSetAt', 'IDriverOptions']) expect(all, hidden).not.to.include(hidden);
    expect(registered('IUserView')).to.deep.equal({ $id: 'spinajs/fw/IUserView', type: 'object' });
    expect(diagnostics.filter((d) => d.severity !== 'info')).to.deep.equal([]);
  });
});
