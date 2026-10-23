import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';

import { UPLOAD_ERRORS, UploadError, contiguousOffset, effectiveLimits, expectedPartSize, isUploadError, missingParts, parseDuration, partCountOf, planParts } from '../src/index.js';
import type { UploadLimits } from '../src/index.js';

const BASE: UploadLimits = { maxFileSize: 1000, partSize: 100, minPartSize: 10, maxPartSize: 200, maxParts: 20, maxOpenSessionsPerOwner: 5, sessionTtl: '24h' };

describe('durations, limits, part math and error codes', () => {
  it('parses durations in ms, s, m, h, d and w', () => {
    expect(['500ms', '10s', '30m', '24h', '7d', '1w', '1.5h'].map((d) => parseDuration(d))).to.deep.equal([500, 10_000, 1_800_000, 86_400_000, 604_800_000, 604_800_000, 5_400_000]);
    expect(() => parseDuration('soon', 'upload.limits.sessionTtl')).to.throw(InvalidArgument, /upload\.limits\.sessionTtl/);
  });

  it('lets an override only tighten the limits', () => {
    expect(effectiveLimits(BASE)).to.deep.equal(BASE);
    expect(effectiveLimits(BASE, { maxFileSize: 500, maxPartSize: 300, maxParts: 30, minPartSize: 5, maxOpenSessionsPerOwner: 2, sessionTtl: '48h' })).to.deep.equal({ ...BASE, maxFileSize: 500, maxOpenSessionsPerOwner: 2 });
    expect(effectiveLimits(BASE, { minPartSize: 50, sessionTtl: '1h', partSize: 150 })).to.deep.equal({ ...BASE, minPartSize: 50, sessionTtl: '1h', partSize: 150 });
  });

  it('ignores an override that is not a finite number instead of loosening the limit', () => {
    expect(effectiveLimits(BASE, { maxFileSize: NaN, maxPartSize: Infinity, maxParts: -Infinity, maxOpenSessionsPerOwner: NaN, minPartSize: NaN })).to.deep.equal(BASE);
  });

  it('splits a file into fixed parts with a shorter last one', () => {
    expect(partCountOf(250, 100)).to.eq(3);
    expect([1, 2, 3].map((n) => expectedPartSize(250, 100, n))).to.deep.equal([100, 100, 50]);
    expect(expectedPartSize(200, 100, 2)).to.eq(100);
  });

  it('reports the missing parts and the contiguous offset from part 1', () => {
    expect(missingParts(3, [2])).to.deep.equal([1, 3]);
    expect(missingParts(3, [1, 2, 3])).to.deep.equal([]);
    expect(contiguousOffset(250, 100, [1, 2])).to.eq(200);
    expect(contiguousOffset(250, 100, [1, 3])).to.eq(100);
    expect(contiguousOffset(250, 100, [2, 3])).to.eq(0);
    expect(contiguousOffset(250, 100, [1, 2, 3])).to.eq(250);
  });

  it('plans the parts of a session or refuses with upload.part_size', () => {
    expect(planParts(250, undefined, BASE)).to.deep.equal({ partSize: 100, partCount: 3 });
    expect(planParts(150, 10, BASE)).to.deep.equal({ partSize: 10, partCount: 15 });
    // A configured default outside the tightened bounds is clamped into them.
    expect(planParts(250, undefined, { ...BASE, maxPartSize: 50 })).to.deep.equal({ partSize: 50, partCount: 5 });
    for (const [size, part] of [[250, 9], [250, 201], [1000, 10], [250, 10.5]]) {
      expect(() => planParts(size, part, BASE), `${size}/${part}`).to.throw(UploadError).with.property('code', 'upload.part_size');
    }
  });

  it('lists every error code once, with the status a controller answers', () => {
    expect(UPLOAD_ERRORS).to.deep.equal({
      'upload.invalid': 400,
      'upload.not_found': 404,
      'upload.too_large': 400,
      'upload.part_size': 400,
      'upload.part_number': 400,
      'upload.too_many_sessions': 429,
      'upload.unsupported_type': 400,
      'upload.length_required': 411,
      'upload.digest_required': 400,
      'upload.part_too_large': 413,
      'upload.part_digest_mismatch': 400,
      'upload.content_mismatch': 415,
      'upload.not_open': 409,
      'upload.expired': 410,
      'upload.assembling': 409,
      'upload.parts_missing': 409,
      'upload.part_corrupted': 409,
      'upload.part_lost': 409,
      'upload.file_digest_required': 400,
      'upload.file_digest_mismatch': 400,
      'upload.size_mismatch': 400,
    });
    const corrupted = new UploadError('upload.part_corrupted', undefined, { parts: [2] });
    expect([corrupted.code, corrupted.status, corrupted.message, corrupted.details]).to.deep.equal(['upload.part_corrupted', 409, 'upload.part_corrupted', { parts: [2] }]);
    expect(new UploadError('upload.unsupported_type', 'x', {}, 415).status).to.eq(415);
    expect(isUploadError(corrupted, 'upload.part_corrupted')).to.eq(true);
    expect(isUploadError(corrupted, 'upload.not_open')).to.eq(false);
    expect(isUploadError(new Error('x'))).to.eq(false);
  });
});
