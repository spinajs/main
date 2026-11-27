import { expect } from 'chai';
import ts from 'typescript';
import { createContext, createProgramFromTsconfig, TRANSPARENT_WRAPPERS } from '../../src/index.js';

const NAMES = ['Ok', 'Json', 'Created', 'NotFound', 'ServerError', 'Unauthorized', 'Conflict', 'NoContent', 'ValidationError', 'NotAllowed', 'EntityTooLarge', 'BadRequest', 'Forbidden'];

const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('reply-wrappers.ts'))!;

function refsOf(table: string, at = { ctx, file }): Record<string, { text: string; schema?: string }> {
  const declaration = at.file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === table)!;
  const properties = at.ctx.checker.getPropertiesOfType(at.ctx.checker.getTypeAtLocation(declaration));
  return Object.fromEntries(properties.map((p) => [p.name, at.ctx.typeRef(at.ctx.checker.getTypeOfSymbolAtLocation(p, declaration), declaration)]));
}
const each = (text: (name: string) => string, schema: (name: string) => string) =>
  Object.fromEntries(NAMES.map((name) => [name, { text: text(name), schema: schema(name) }]));
const ownSchema = each((name) => `${name}<Payload>`, (name) => `spinajs/unit/${name}_Payload`);
const payload = each(() => 'Payload', () => 'spinajs/unit/Payload');

describe('reply wrappers are http responses by their declaring package', () => {
  it('describes an application class named like an http reply by its own schema', () => {
    expect(refsOf('AppReplies')).to.deep.equal(ownSchema);
    expect(refsOf('PromisedAppReplies')).to.deep.equal(ownSchema);
  });
  it("describes another package's class named like an http reply by its own schema", () => {
    expect(refsOf('LibReplies')).to.deep.equal(ownSchema);
    expect(refsOf('PromisedLibReplies')).to.deep.equal(ownSchema);
  });
  it('matches the http package by its name, not by a folder named http', () => {
    expect(refsOf('HttpFolderReplies')).to.deep.equal({ Ok: ownSchema.Ok, NotFound: ownSchema.NotFound });
  });
  it('keeps the payload in the own schema of a lookalike', () => {
    expect(ctx.schemaRegistry.get('spinajs/unit/Ok_Payload')).to.have.deep.nested.property('properties.data', { $ref: 'spinajs/unit/Payload' });
  });
  it('unwraps the http replies, imported, re-exported under an alias and subclassed', () => {
    for (const table of ['HttpReplies', 'PromisedHttpReplies', 'ReexportedReplies', 'SubclassedReplies']) {
      expect(refsOf(table), table).to.deep.equal(payload);
    }
    expect(refsOf('ImportedAsReplies')).to.deep.equal({ Fine: payload.Ok, Missing: payload.NotFound, OkAlias: payload.Ok });
  });
  it('unwraps a type alias of an http reply to the type argument the alias passes', () => {
    expect(refsOf('AliasedReplies')).to.deep.equal({ MissingPayload: payload.NotFound, PromisedMissingPayload: payload.NotFound, OkList: { text: 'Payload[]' } });
  });
  it('unwraps ModelData and ModelDataWithRelationData inside Promise and Ok to the model', () => {
    const model = payload.Ok;
    expect(refsOf('ModelDataReplies')).to.deep.equal({
      PromisedModelData: model,
      OkModelData: model,
      PromisedModelDataWithRelationData: model,
      OkModelDataWithRelationData: model,
    });
  });
  it('follows a type alias of Promise to its payload', () => {
    expect(refsOf('PromiseAliases')).to.deep.equal({ AsyncOk: payload.Ok, PromiseList: { text: 'Payload[]' }, PromisedPayload: payload.Ok });
  });
  it("unwraps the global Promise declared by a project's own lib file under noLib", () => {
    const own = createProgramFromTsconfig('test/fixtures/promise-own-lib/tsconfig.json');
    const at = { ctx: createContext(own, 'own-lib', 'test/fixtures/promise-own-lib'), file: own.sourceFiles.find((f) => f.fileName.endsWith('rows.ts'))! };
    const model = { text: 'Payload', schema: 'spinajs/own-lib/Payload' };
    expect(refsOf('ProbeRows', at)).to.deep.equal({ P: model, A: model });
  });
  it('describes an application type named Promise, ModelData or ModelDataWithRelationData by its own schema', () => {
    expect(refsOf('WrapperLookalikes')).to.deep.equal({
      Promise: { text: 'Promise<Payload>', schema: 'spinajs/unit/Promise_Payload' },
      AliasedPromise: { text: 'LookAsync<Payload>', schema: 'spinajs/unit/Promise_Payload' },
      ModelData: { text: 'ModelData<Payload>', schema: 'spinajs/unit/ModelData_Payload' },
      ModelDataWithRelationData: { text: 'ModelDataWithRelationData<Payload>', schema: 'spinajs/unit/ModelDataWithRelationData_Payload' },
    });
  });
  it('leaves a generic subclass of an http reply bare: its type argument need not be the payload', () => {
    expect(refsOf('GenericSubclassReplies')).to.deep.equal({ MyGenericOk: { text: 'MyGenericOk' } });
  });
  it('describes the exceptions BadRequest and Forbidden by their own schema', () => {
    const refs = refsOf('Exceptions');
    expect(refs.BadRequest.text).to.equal('BadRequest');
    expect(refs.BadRequest.schema).to.be.a('string');
    expect(refs.Forbidden.text).to.equal('Forbidden');
    expect(refs.Forbidden.schema).to.be.a('string');
  });
  it('keeps the wrappers that are not http classes by name', () => {
    expect([...TRANSPARENT_WRAPPERS]).to.have.members(['Promise', 'ModelDataWithRelationData', 'ModelData']);
  });
});
