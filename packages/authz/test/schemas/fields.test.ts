import * as chai from 'chai';
import 'mocha';

import {
  AUTHZ_FIELD_SCHEMAS,
  bodyOf,
  changeTagField,
  changeTagsField,
  fieldNameField,
  fieldSchema,
  idempotencyKeyField,
  idField,
  isValidField,
  linkTokenField,
  nameField,
  pageField,
  permissionField,
  principalRefField,
  reasonField,
  resourceRefField,
  serviceTokenField,
  typeField,
  writeOptionsField,
} from '../../src/schemas/fields.js';
import { PERMISSION_MAX_LENGTH } from '../../src/contracts/permission.js';
import * as root from '../../src/index.js';

const expect = chai.expect;

const strings: [string, object, number, number][] = [
  ['idField', idField, 1, 160],
  ['typeField', typeField, 1, 64],
  ['nameField', nameField, 1, 128],
  ['fieldNameField', fieldNameField, 1, 128],
  ['reasonField', reasonField, 0, 512],
  ['idempotencyKeyField', idempotencyKeyField, 1, 128],
  ['linkTokenField', linkTokenField, 1, 512],
  ['serviceTokenField', serviceTokenField, 1, 1024],
  ['changeTagField', changeTagField, 0, 256],
];

describe('authz field schemas', () => {
  for (const [name, field, min, max] of strings) {
    describe(name, () => {
      it(`accepts ${min} and ${max} characters`, () => {
        expect(isValidField(field, 'a'.repeat(min))).to.eq(true);
        expect(isValidField(field, 'a'.repeat(max))).to.eq(true);
      });

      it(`rejects ${max + 1} characters`, () => {
        expect(isValidField(field, 'a'.repeat(max + 1))).to.eq(false);
        if (min > 0) expect(isValidField(field, '')).to.eq(false);
      });

      it('rejects a value of another type, without coercing it', () => {
        for (const v of [1, true, null, undefined, ['a'], { a: 'a' }]) expect(isValidField(field, v)).to.eq(false, JSON.stringify(v));
      });
    });
  }

  it(`permissionField takes a permission name of at most ${PERMISSION_MAX_LENGTH} characters`, () => {
    expect(PERMISSION_MAX_LENGTH).to.eq(256);
    expect(isValidField(permissionField, 'fs:read')).to.eq(true);
    expect(isValidField(permissionField, `a:${'b'.repeat(254)}`)).to.eq(true);
    expect(isValidField(permissionField, `a:${'b'.repeat(255)}`)).to.eq(false);
    for (const v of ['fs', 'fs:*', ':read', '', 1]) expect(isValidField(permissionField, v)).to.eq(false, String(v));
  });

  it('resourceRefField takes { type, id? }, each capped', () => {
    expect(isValidField(resourceRefField, { type: 'doc' })).to.eq(true);
    expect(isValidField(resourceRefField, { type: 'doc', id: 'd'.repeat(160) })).to.eq(true);
    expect(isValidField(resourceRefField, { type: 'doc', id: 'd'.repeat(161) })).to.eq(false);
    expect(isValidField(resourceRefField, { type: 't'.repeat(65) })).to.eq(false);
    expect(isValidField(resourceRefField, { id: 'd1' })).to.eq(false);
    expect(isValidField(resourceRefField, { type: 'doc', extra: 1 })).to.eq(false);
  });

  it('principalRefField takes { type, id }, both required', () => {
    expect(isValidField(principalRefField, { type: 'user', id: 'u1' })).to.eq(true);
    expect(isValidField(principalRefField, { type: 'user' })).to.eq(false);
    expect(isValidField(principalRefField, { type: 'user', id: 'u'.repeat(161) })).to.eq(false);
  });

  it('pageField takes limit 0..500, offset >= 0 and a cursor', () => {
    expect(isValidField(pageField, {})).to.eq(true);
    expect(isValidField(pageField, { limit: 500, offset: 0, after: 'c' })).to.eq(true);
    expect(isValidField(pageField, { limit: 501 })).to.eq(false);
    expect(isValidField(pageField, { limit: '5' })).to.eq(false);
    expect(isValidField(pageField, { offset: -1 })).to.eq(false);
    expect(isValidField(pageField, { after: '' })).to.eq(false);
    expect(isValidField(pageField, { size: 1 })).to.eq(false);
  });

  it('writeOptionsField takes reason, idempotencyKey and dryRun, nothing else', () => {
    expect(isValidField(writeOptionsField, { reason: 'r', idempotencyKey: 'k', dryRun: true })).to.eq(true);
    expect(isValidField(writeOptionsField, { reason: 'r'.repeat(513) })).to.eq(false);
    expect(isValidField(writeOptionsField, { idempotencyKey: 'k'.repeat(129) })).to.eq(false);
    expect(isValidField(writeOptionsField, { dryRun: 'true' })).to.eq(false);
    expect(isValidField(writeOptionsField, { other: 1 })).to.eq(false);
  });

  it('changeTagsField takes at most 1000 tags', () => {
    expect(isValidField(changeTagsField, Array.from({ length: 1000 }, () => 't'))).to.eq(true);
    expect(isValidField(changeTagsField, Array.from({ length: 1001 }, () => 't'))).to.eq(false);
    expect(isValidField(changeTagsField, ['t'.repeat(257)])).to.eq(false);
  });

  describe('bodyOf', () => {
    const body = bodyOf(['object', 'permission'], { object: resourceRefField, permission: permissionField, other: resourceRefField }, 'authz.test.Body');

    it('builds a closed object schema with the $id given; a field may appear twice', () => {
      expect(body).to.deep.include({ $id: 'authz.test.Body', type: 'object', additionalProperties: false, required: ['object', 'permission'] });
      expect(isValidField(body, { object: { type: 'doc' }, permission: 'doc:read', other: { type: 'doc' } })).to.eq(true);
    });

    it('rejects an unknown key', () => {
      expect(isValidField(body, { object: { type: 'doc' }, permission: 'doc:read', extra: 1 })).to.eq(false);
    });

    it('refuses an $id outside the authz. prefix', () => {
      expect(() => bodyOf([], {}, 'Body')).to.throw(/authz\./);
    });
  });

  it('fieldSchema adds an authz. $id; AUTHZ_FIELD_SCHEMAS ids are unique', () => {
    expect(fieldSchema('authz.field.x', idField)).to.deep.eq({ $id: 'authz.field.x', ...idField });
    expect(() => fieldSchema('authn.x', idField)).to.throw(/authz\./);
    const ids = Object.values(AUTHZ_FIELD_SCHEMAS).map((s) => s.$id);
    expect(ids.every((id) => id.startsWith('authz.'))).to.eq(true);
    expect(new Set(ids).size).to.eq(ids.length);
  });

  it('the fragments carry no $id', () => {
    for (const [name, field] of strings) expect(field, name).to.not.have.property('$id');
  });

  it('the package root exports them', () => {
    expect(root.permissionField).to.eq(permissionField);
    expect(root.isValidField).to.eq(isValidField);
    expect(root.AUTHZ_FIELD_SCHEMAS).to.eq(AUTHZ_FIELD_SCHEMAS);
  });
});
