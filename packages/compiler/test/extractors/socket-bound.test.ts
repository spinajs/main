import { expect } from 'chai';
import { hashManifest, type Manifest } from '@spinajs/manifest';
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
});
