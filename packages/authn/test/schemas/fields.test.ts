import * as chai from 'chai';
import 'mocha';

import {
  bodyOf,
  codeField,
  fieldSchema,
  identityRefField,
  isoInstantField,
  isValidField,
  kidField,
  loginField,
  mfaResponseField,
  mfaStepField,
  oidcGroupField,
  oidcGroupsField,
  oidcSubjectField,
  passwordField,
  reauthPasswordField,
  secretField,
  sessionHandleField,
  tokenIdField,
  tokenSecretField,
  AUTHN_FIELD_SCHEMAS,
} from '../../src/schemas/fields.js';
import * as root from '../../src/index.js';

const expect = chai.expect;

const cases: [string, object, number][] = [
  ['loginField', loginField, 1024],
  ['passwordField', passwordField, 1024],
  ['secretField', secretField, 1024],
  ['codeField', codeField, 1024],
  ['reauthPasswordField', reauthPasswordField, 1024],
  ['tokenSecretField', tokenSecretField, 1024],
  ['tokenIdField', tokenIdField, 64],
  ['sessionHandleField', sessionHandleField, 128],
  ['mfaStepField', mfaStepField, 64],
  ['mfaResponseField', mfaResponseField, 65536],
  ['oidcSubjectField', oidcSubjectField, 255],
];

describe('authn field schemas', () => {
  for (const [name, field, max] of cases) {
    describe(name, () => {
      it(`accepts 1 and ${max} characters`, () => {
        expect(isValidField(field, 'a')).to.eq(true);
        expect(isValidField(field, 'a'.repeat(max))).to.eq(true);
      });

      it(`rejects ${max + 1} characters and the empty string`, () => {
        expect(isValidField(field, 'a'.repeat(max + 1))).to.eq(false);
        expect(isValidField(field, '')).to.eq(false);
      });

      it('rejects a value of another type, without coercing it', () => {
        for (const v of [1, true, null, undefined, ['a'], { a: 'a' }]) expect(isValidField(field, v)).to.eq(false, JSON.stringify(v));
      });
    });
  }

  it('kidField takes 1 to 64 of [A-Za-z0-9._-]', () => {
    expect(isValidField(kidField, 'k')).to.eq(true);
    expect(isValidField(kidField, 'A-z_0.9'.padEnd(64, 'x'))).to.eq(true);
    expect(isValidField(kidField, 'x'.repeat(65))).to.eq(false);
    expect(isValidField(kidField, '')).to.eq(false);
    expect(isValidField(kidField, 'a b')).to.eq(false);
    expect(isValidField(kidField, 'a/b')).to.eq(false);
  });

  it('isoInstantField takes an RFC 3339 date-time of at most 40 characters', () => {
    expect(isValidField(isoInstantField, '2026-10-21T10:00:00Z')).to.eq(true);
    expect(isValidField(isoInstantField, '2026-10-21T10:00:00.123+02:00')).to.eq(true);
    expect(isValidField(isoInstantField, '2026-10-21')).to.eq(false);
    expect(isValidField(isoInstantField, '2026-13-45T10:00:00Z')).to.eq(false);
    expect(isValidField(isoInstantField, `2026-10-21T10:00:00.${'1'.repeat(30)}Z`)).to.eq(false);
    expect(isValidField(isoInstantField, 1761040800000)).to.eq(false);
  });

  it('identityRefField takes a string id or { type, id }, each capped', () => {
    expect(isValidField(identityRefField, 'u1')).to.eq(true);
    expect(isValidField(identityRefField, 'a'.repeat(256))).to.eq(true);
    expect(isValidField(identityRefField, 'a'.repeat(257))).to.eq(false);
    expect(isValidField(identityRefField, { type: 'user', id: 'u1' })).to.eq(true);
    expect(isValidField(identityRefField, { type: 't'.repeat(65), id: 'u1' })).to.eq(false);
    expect(isValidField(identityRefField, { type: 'user', id: 'a'.repeat(257) })).to.eq(false);
    expect(isValidField(identityRefField, { type: 'user' })).to.eq(false);
    expect(isValidField(identityRefField, { type: 'user', id: 'u1', extra: 1 })).to.eq(false);
  });

  it('oidcGroupField takes a string of at most 255 characters, the empty one too', () => {
    expect(isValidField(oidcGroupField, '')).to.eq(true);
    expect(isValidField(oidcGroupField, 'g'.repeat(255))).to.eq(true);
    expect(isValidField(oidcGroupField, 'g'.repeat(256))).to.eq(false);
    expect(isValidField(oidcGroupField, 1)).to.eq(false);
  });

  it('oidcGroupsField takes at most 256 groups of at most 255 characters', () => {
    expect(isValidField(oidcGroupsField, [])).to.eq(true);
    expect(isValidField(oidcGroupsField, Array.from({ length: 256 }, (_, i) => `g${i}`))).to.eq(true);
    expect(isValidField(oidcGroupsField, Array.from({ length: 257 }, (_, i) => `g${i}`))).to.eq(false);
    expect(isValidField(oidcGroupsField, ['a'.repeat(256)])).to.eq(false);
    expect(isValidField(oidcGroupsField, [1])).to.eq(false);
  });

  describe('bodyOf', () => {
    const body = bodyOf(['login', 'password'], { login: loginField, password: passwordField, confirmPassword: passwordField }, 'authn.test.Body');

    it('builds a closed object schema with the $id given', () => {
      expect(body).to.deep.include({ $id: 'authn.test.Body', type: 'object', additionalProperties: false, required: ['login', 'password'] });
    });

    it('accepts a valid body, also one that embeds a field twice', () => {
      expect(isValidField(body, { login: 'a', password: 'p', confirmPassword: 'p' })).to.eq(true);
    });

    it('rejects an unknown key, a missing required key and an over-long field', () => {
      expect(isValidField(body, { login: 'a', password: 'p', extra: 1 })).to.eq(false);
      expect(isValidField(body, { login: 'a' })).to.eq(false);
      expect(isValidField(body, { login: 'a', password: 'p'.repeat(1025) })).to.eq(false);
    });

    it('refuses an $id outside the authn. prefix', () => {
      expect(() => bodyOf([], {}, 'Body')).to.throw(/authn\./);
    });
  });

  describe('standalone schemas', () => {
    it('fieldSchema adds the $id and refuses one outside the authn. prefix', () => {
      expect(fieldSchema('authn.field.x', loginField)).to.deep.eq({ $id: 'authn.field.x', ...loginField });
      expect(() => fieldSchema('x', loginField)).to.throw(/authn\./);
    });

    it('every AUTHN_FIELD_SCHEMAS entry has a unique authn. $id', () => {
      const ids = Object.values(AUTHN_FIELD_SCHEMAS).map((s) => s.$id);
      expect(ids.every((id) => id.startsWith('authn.'))).to.eq(true);
      expect(new Set(ids).size).to.eq(ids.length);
      expect(isValidField(AUTHN_FIELD_SCHEMAS.login, 'a'.repeat(1025))).to.eq(false);
    });
  });

  it('the fragments carry no $id, so they embed anywhere', () => {
    for (const [name, field] of cases) expect(field, name).to.not.have.property('$id');
  });

  it('the package root exports them', () => {
    expect(root.loginField).to.eq(loginField);
    expect(root.bodyOf).to.eq(bodyOf);
    expect(root.isValidField).to.eq(isValidField);
  });
});
