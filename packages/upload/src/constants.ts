/** Connection alias of every upload table; the shipped config points it at `default` (pattern of authz-orm/src/config/db.ts:1-8). */
export const UPLOAD_CONNECTION = 'upload';

export const UPLOAD_SESSIONS_TABLE = 'upload_sessions';
export const UPLOAD_PARTS_TABLE = 'upload_parts';
export const UPLOAD_BLOBS_TABLE = 'upload_blobs';

/** Ceiling of upload.limits.maxPartSize and of the controller's @RequestStream maxBytes, which is fixed at class declaration. 5 GiB, the largest S3 part. */
export const UPLOAD_MAX_PART_BYTES = 5 * 1024 ** 3;
