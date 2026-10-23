import { parseDuration } from './duration.js';
import { UploadError } from './errors.js';
import { partCountOf } from './parts.js';
import type { UploadLimits } from './types.js';

// Math.min/max return NaN for a NaN operand, which every later comparison passes, so a non-finite override is ignored.
const usable = (override: number | undefined): override is number => override !== undefined && Number.isFinite(override);

const tighter = (base: number, override: number | undefined): number => (usable(override) ? Math.min(base, override) : base);

/** The configured limits with a controller's limitsFor() applied; an override can only tighten them (spec §6.2). */
export function effectiveLimits(base: UploadLimits, override: Partial<UploadLimits> = {}): UploadLimits {
  const shorterTtl = override.sessionTtl !== undefined && parseDuration(override.sessionTtl, 'limits.sessionTtl') < parseDuration(base.sessionTtl, 'upload.limits.sessionTtl');
  return {
    maxFileSize: tighter(base.maxFileSize, override.maxFileSize),
    partSize: override.partSize ?? base.partSize,
    minPartSize: usable(override.minPartSize) ? Math.max(base.minPartSize, override.minPartSize) : base.minPartSize,
    maxPartSize: tighter(base.maxPartSize, override.maxPartSize),
    maxParts: tighter(base.maxParts, override.maxParts),
    maxOpenSessionsPerOwner: tighter(base.maxOpenSessionsPerOwner, override.maxOpenSessionsPerOwner),
    sessionTtl: shorterTtl ? override.sessionTtl! : base.sessionTtl,
  };
}

/** The part size asked for, or the default clamped into min..max; refused with upload.part_size (spec §8). */
export function planParts(size: number, requested: number | undefined, limits: UploadLimits): { partSize: number; partCount: number } {
  const partSize = requested ?? Math.min(Math.max(limits.partSize, limits.minPartSize), limits.maxPartSize);
  const partCount = partCountOf(size, partSize);
  if (!Number.isSafeInteger(partSize) || partSize < limits.minPartSize || partSize > limits.maxPartSize || partCount > limits.maxParts) {
    throw new UploadError('upload.part_size', `part size ${partSize} must be ${limits.minPartSize}..${limits.maxPartSize} bytes and give at most ${limits.maxParts} parts`);
  }
  return { partSize, partCount };
}
