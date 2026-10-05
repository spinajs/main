import type { FsProviderKind } from './fs-harness.js';
import { S3_SKIP_HINT, s3Reachable } from './s3.js';

export const FS_PROVIDER_KINDS: readonly FsProviderKind[] = ['local', 'temp', 's3'];

/**
 * One mocha suite per provider kind, titled with the kind (the release gate greps `local`, `temp` and `s3`).
 * Without localstack the s3 suite is pending with a message; it never fails for that reason.
 */
export function forEachKind(kinds: readonly FsProviderKind[], body: (kind: FsProviderKind) => void): void {
  for (const kind of kinds) {
    describe(kind, function () {
      if (kind === 's3') {
        before(async function () {
          if (await s3Reachable()) return;
          console.warn(`      ${this.test?.parent?.fullTitle() ?? 's3'} skipped: ${S3_SKIP_HINT}`);
          this.skip();
        });
      }
      body(kind);
    });
  }
}
