import { expect } from 'chai';
import { hashManifest, mergeFragments, type Manifest, type ManifestFragment, type SocketContractEntry } from '@spinajs/manifest';
import { createProgramFromTsconfig, createContext, extractSocketContracts, extractSocketControllers } from '../../src/index.js';
import { socketContract } from '../../src/doctor/rules/socket-contract.js';
import { createDoctorContext, DEFAULT_RULES } from '../../src/doctor/index.js';
import { fixture } from '../doctor/fixture.js';

describe('socket controllers bound to a contract', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('socket-bound.ts'))!;
  const controllers = extractSocketControllers(ctx, file);
  const contracts = extractSocketContracts(ctx, file);

  it('records the id of the contract named in the decorator options', () => {
    expect(controllers.map((c) => [c.className, c.contract])).to.deep.equal([
      ['GreetSocket', 'unit:GREET_CONTRACT'],
      ['NamedSocket', 'greet.v1'],
      ['PlainSocket', undefined],
    ]);
  });

  it('takes the contract id from a literal defineContract argument, else from the variable name', () => {
    expect(contracts.map((c) => c.id)).to.deep.equal(['unit:GREET_CONTRACT', 'greet.v1']);
  });

  it('the doctor rule is a default rule and reports a missing handler, a result mismatch', () => {
    expect(DEFAULT_RULES).to.include(socketContract);
    const manifest: Manifest = { ...fixture(), socketControllers: controllers, socketContracts: contracts, schemas: Object.fromEntries(ctx.schemaRegistry) };
    manifest.hash = hashManifest(manifest);

    const found = socketContract.run(manifest, createDoctorContext(manifest, { cwd: process.cwd() })).map((d) => `${d.code} ${d.severity}`);
    // GreetSocket lacks greet.bye (SOCK001) and returns { count: string } for greet.wave's Waved (SOCK003)
    expect(found).to.include('SOCK001 error');
    expect(found).to.include('SOCK003 warning');
    // NamedSocket lacks all three commands
    expect(found.filter((f) => f === 'SOCK001 error')).to.have.length(4);
  });

  it('reports a contract id declared twice as SOCK005', () => {
    const manifest: Manifest = { ...fixture(), socketContracts: [contracts[0], { ...contracts[0], source: { ...contracts[0].source, line: 99 } }] };
    manifest.hash = hashManifest(manifest);

    const found = socketContract.run(manifest, createDoctorContext(manifest, { cwd: process.cwd() }));
    expect(found.filter((d) => d.code === 'SOCK005')).to.have.length(1);
  });

  describe('a $data rule in a contract payload', () => {
    const range = (pointer: string, required: string[]) => ({
      type: 'object',
      properties: { low: { type: 'integer' }, high: { type: 'integer', minimum: { $data: pointer } }, nested: { type: 'object', properties: { top: { type: 'integer', maximum: { $data: '2/low' } } } } },
      required,
    });
    const reported = (schema: object, event = false): string[] => {
      const payload = { text: 'Range', schema: 'spinajs/app/Range' };
      const contract: SocketContractEntry = { id: 'app:C', commands: event ? {} : { 'c.set': { payload, result: { text: 'void' } } }, events: {}, clientEvents: event ? { 'c.set': payload } : {}, source: contracts[0].source };
      const manifest: Manifest = { ...fixture(), socketContracts: [contract], schemas: { 'spinajs/app/Range': schema } };
      return socketContract.run(manifest, createDoctorContext(manifest, { cwd: process.cwd() })).filter((d) => d.code === 'SOCK006').map((d) => `${d.severity} ${d.message}`);
    };

    it('is quiet when the pointer names a required property', () => {
      expect(reported(range('1/low', ['low', 'high']))).to.deep.equal([]);
    });

    it('warns about a pointer that names no property, where nothing else reports the typo', () => {
      expect(reported(range('1/lwo', ['low', 'high']))).to.include("warning app:C: c.set: $data pointer 1/lwo names no property, so the rule never applies");
    });

    it('warns about a pointer to an optional property, which a client skips by omitting it', () => {
      expect(reported(range('1/low', ['high']))).to.include("warning app:C: c.set: $data pointer 1/low names optional property low: a client that omits it skips the rule");
    });

    it('checks client events too, and pointers it can only partly follow are left alone', () => {
      expect(reported(range('1/lwo', ['low']), true)).to.have.length(1);
      expect(reported(range('1/low/deeper', ['low']))).to.deep.equal([]);
      expect(reported(range('/low', ['low']))).to.deep.equal([]);
    });
  });

  it('two packages declaring one explicit id reach SOCK005 through the merge', () => {
    const named = contracts.find((c) => c.id === 'greet.v1')!;
    const fragmentOf = (name: string) => ({ ...fixture(), package: { name, version: '1.0.0' }, socketContracts: [named], schemas: {} }) as unknown as ManifestFragment;
    const merged = mergeFragments(fragmentOf('app'), [fragmentOf('dep')], { app: fixture().app, packages: [] });

    expect(merged.socketContracts.map((c) => c.id)).to.deep.equal(['greet.v1', 'greet.v1']);
    const found = socketContract.run(merged, createDoctorContext(merged, { cwd: process.cwd() }));
    expect(found.filter((d) => d.code === 'SOCK005').map((d) => d.message)).to.deep.equal(['socket contract id greet.v1 is declared more than once; give each defineContract a unique id']);
  });
});
