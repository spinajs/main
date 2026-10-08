import * as chai from 'chai';
import 'mocha';

import { DEFAULT_AUDIT_SAMPLE_USE, DEFAULT_AUDIT_SINK_TIMEOUT_MS, MAX_AUDIT_SINK_TIMEOUT_MS, MIN_AUDIT_HASH_KEY_LENGTH } from '../../src/audit/config.js';
import { AUTHN_CONFIGURATION_SCHEMA } from '../../src/schemas/authn.configuration.js';

const expect = chai.expect;

// src/schemas imports nothing outside its own files, so the schema repeats these values as literals.
describe('authn.audit schema and the audit constants', () => {
  const audit = AUTHN_CONFIGURATION_SCHEMA.properties.audit.properties;

  it('agree on every value the schema repeats', () => {
    expect(audit.sampleUse.default).to.eq(DEFAULT_AUDIT_SAMPLE_USE);
    expect(audit.hashKey.properties.secret.minLength).to.eq(MIN_AUDIT_HASH_KEY_LENGTH);
    expect(audit.sinkTimeoutMs.default).to.eq(DEFAULT_AUDIT_SINK_TIMEOUT_MS);
    expect(audit.sinkTimeoutMs.maximum).to.eq(MAX_AUDIT_SINK_TIMEOUT_MS);
  });
});
