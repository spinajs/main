import { expect } from 'chai';
import ts from 'typescript';
import { createContext, createProgramFromTsconfig, TRANSPARENT_WRAPPERS } from '../../src/index.js';

const NAMES = ['Ok', 'Json', 'Created', 'NotFound', 'ServerError', 'Unauthorized', 'Conflict', 'NoContent', 'ValidationError', 'NotAllowed', 'EntityTooLarge', 'BadRequest', 'Forbidden'];

const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('reply-wrappers.ts'))!;

function refsOf(table: string): Record<string, { text: string; schema?: string }> {
  const declaration = file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === table)!;
  const properties = ctx.checker.getPropertiesOfType(ctx.checker.getTypeAtLocation(declaration));
  return Object.fromEntries(properties.map((p) => [p.name, ctx.typeRef(ctx.checker.getTypeOfSymbolAtLocation(p, declaration), declaration)]));
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
