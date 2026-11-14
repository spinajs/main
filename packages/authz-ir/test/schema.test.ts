import 'mocha';
import { expect } from 'chai';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { POLICY_IR_SCHEMA } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';

describe('POLICY_IR_SCHEMA', () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(POLICY_IR_SCHEMA);

  it('accepts the docs fixture', () => {
    expect(validate(docsIR()), JSON.stringify(validate.errors)).to.equal(true);
  });

  it('round-trips through JSON', () => {
    expect(validate(JSON.parse(JSON.stringify(docsIR())))).to.equal(true);
  });

  it('rejects an unknown rewrite, a wrong version and a malformed subject type', () => {
    const bad = docsIR() as unknown as Record<string, unknown>;
    bad.version = 2;
    const ir = docsIR();
    ir.types.doc.permissions.edit = { bogus: 'x' } as never;
    const subject = docsIR();
    subject.types.doc.relations.banned.allowed = ['group#member#x'];
    expect(validate(bad)).to.equal(false);
    expect(validate(ir)).to.equal(false);
    expect(validate(subject)).to.equal(false);
  });
});
