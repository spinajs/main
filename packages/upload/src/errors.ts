import { Exception } from '@spinajs/exceptions';

/**
 * Every refusal of the upload service, with the HTTP status a controller answers (spec §4, §8).
 * upload.unsupported_type is 400 for a name at create and 415 for content; that throw passes 415.
 */
export const UPLOAD_ERRORS = {
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
  /** The part's temp object was reclaimed before its commit (the write outlived the writing grace); the client resends it. */
  'upload.part_lost': 409,
  /** The assembled file was reclaimed before its commit; the claim is released with the parts intact and the client retries complete. */
  'upload.file_lost': 409,
  'upload.file_digest_required': 400,
  'upload.file_digest_mismatch': 400,
  'upload.size_mismatch': 400,
} as const satisfies Record<string, number>;

export type UploadErrorCode = keyof typeof UPLOAD_ERRORS;

export const UPLOAD_ERROR_CODES = Object.keys(UPLOAD_ERRORS) as UploadErrorCode[];

export interface UploadErrorDetails {
  /** Part numbers the client must (re)send: upload.parts_missing, upload.part_corrupted. */
  readonly parts?: readonly number[];
}

export class UploadError extends Exception {
  public readonly status: number;

  constructor(
    public readonly code: UploadErrorCode,
    message?: string,
    public readonly details: UploadErrorDetails = {},
    status?: number,
  ) {
    super(message ?? code);
    this.status = status ?? UPLOAD_ERRORS[code];
  }
}

export function isUploadError(e: unknown, code?: UploadErrorCode): e is UploadError {
  return e instanceof UploadError && (code === undefined || e.code === code);
}
