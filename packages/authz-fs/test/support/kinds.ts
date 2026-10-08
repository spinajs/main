import type { FsProviderKind } from './fs-harness.js';
import { requireOrSkipS3 } from './s3.js';

export const FS_PROVIDER_KINDS: readonly FsProviderKind[] = ['local', 'temp', 's3'];

/**
 * One mocha suite per provider kind, titled with the kind (the release gate greps `local`, `temp` and `s3`).
 * Without localstack the s3 suite is pending with a message, unless AUTHZ_FS_S3=required makes it fail.
 */
export function forEachKind(kinds: readonly FsProviderKind[], body: (kind: FsProviderKind) => void): void {
  for (const kind of kinds) {
    describe(kind, function () {
      if (kind === 's3') {
        before(async function () {
          await requireOrSkipS3(this, this.test?.parent?.fullTitle() ?? 's3');
        });
      }
      body(kind);
    });
  }
}
