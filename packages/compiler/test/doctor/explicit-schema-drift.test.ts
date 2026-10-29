import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { explicitSchemaDrift, structuralDiff } from '../../src/doctor/rules/explicit-schema-drift.js';
import { createDoctorContext, DEFAULT_RULES } from '../../src/doctor/index.js';
import { fixture } from './fixture.js';

const loadFixture = (name: string) =>
  fixture(JSON.parse(readFileSync(new URL(`../fixtures/doctor/${name}.manifest.json`, import.meta.url), 'utf8')) as Parameters<typeof fixture>[0]);

describe('SCH003 explicit-schema-drift', () => {
  it('reports properties and required sets that differ between the explicit schema and the class', () => {
    const manifest = loadFixture('explicit-schema-drift');
    const diagnostics = explicitSchemaDrift.run(manifest, createDoctorContext(manifest, { cwd: process.cwd() }));
    expect(diagnostics).to.have.length(1);
    expect(diagnostics[0].code).to.equal('SCH003');
    expect(diagnostics[0].message).to.include('property Extra only in class');
    expect(diagnostics[0].message).to.include('required differs');
  });
  it('structuralDiff is empty for equal shapes', () => {
    expect(
      structuralDiff({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }),
    ).to.deep.equal([]);
  });
  it('is part of the default rules', () => {
    expect(DEFAULT_RULES).to.include(explicitSchemaDrift);
  });
});
