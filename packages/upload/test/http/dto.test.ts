import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

import { COMPLETE_UPLOAD_SCHEMA, CREATE_UPLOAD_SCHEMA, CompleteUploadDto, CreateUploadDto } from '../../src/http/index.js';
import { uploadEnv } from '../support/env.js';

describe('upload DTOs', () => {
  let validator: DataValidator;
  const valid = (schema: object, data: object): boolean => validator.tryValidate(schema, data)[0];

  before(async () => {
    await uploadEnv();
    validator = await DI.resolve(DataValidator);
  });

  it('accepts the create body of spec §3', () => {
    expect(valid(CREATE_UPLOAD_SCHEMA, { name: 'notes.txt', size: 10 })).to.eq(true);
    expect(valid(CREATE_UPLOAD_SCHEMA, { name: 'notes.txt', size: 10, sha256: 'a'.repeat(64), partSize: 4, metadata: { projectId: 'p1' } })).to.eq(true);
  });

  it('refuses a create body without name or size, with a malformed value, or with a field of its own such as owner', () => {
    const bodies = [
      { size: 10 },
      { name: 'notes.txt' },
      { name: '', size: 10 },
      { name: 'x'.repeat(256), size: 10 },
      { name: 'notes.txt', size: 0 },
      { name: 'notes.txt', size: 1.5 },
      { name: 'notes.txt', size: 10, sha256: 'xyz' },
      { name: 'notes.txt', size: 10, metadata: [] },
      { name: 'notes.txt', size: 10, owner: 'mallory' },
    ];
    for (const body of bodies) expect(valid(CREATE_UPLOAD_SCHEMA, body), JSON.stringify(body)).to.eq(false);
  });

  it('accepts an empty or hashed complete body and refuses anything else', () => {
    expect(valid(COMPLETE_UPLOAD_SCHEMA, {})).to.eq(true);
    expect(valid(COMPLETE_UPLOAD_SCHEMA, { sha256: 'A'.repeat(64) })).to.eq(true);
    expect(valid(COMPLETE_UPLOAD_SCHEMA, { sha256: 'short' })).to.eq(false);
    expect(valid(COMPLETE_UPLOAD_SCHEMA, { size: 10 })).to.eq(false);
  });

  it('binds each DTO to its schema and takes only the fields of a JSON object', () => {
    expect(validator.extractSchema(CreateUploadDto)).to.deep.equal(CREATE_UPLOAD_SCHEMA);
    expect(validator.extractSchema(CompleteUploadDto)).to.deep.equal(COMPLETE_UPLOAD_SCHEMA);
    expect({ ...new CreateUploadDto({ name: 'notes.txt', size: 10 }) }).to.deep.equal({ name: 'notes.txt', size: 10 });
    expect({ ...new CreateUploadDto('notes.txt') }).to.deep.equal({});
    expect({ ...new CompleteUploadDto(null) }).to.deep.equal({});
  });
});
