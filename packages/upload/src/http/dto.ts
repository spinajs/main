import { Schema } from '@spinajs/validation';

const SHA256_HEX = { type: 'string', pattern: '^[0-9a-fA-F]{64}$' };

/** Body of `POST {base}` (spec §3): its shape only. The service checks the limits, the name's type and the owner's cap. */
export const CREATE_UPLOAD_SCHEMA = {
  $id: 'upload.CreateUploadBody',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'size'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    size: { type: 'integer', minimum: 1 },
    sha256: SHA256_HEX,
    partSize: { type: 'integer', minimum: 1 },
    metadata: { type: 'object' },
  },
};

/** Body of `POST {base}/:upload/complete` (spec §3): the file's sha-256, when it was not declared at create. */
export const COMPLETE_UPLOAD_SCHEMA = {
  $id: 'upload.CompleteUploadBody',
  type: 'object',
  additionalProperties: false,
  properties: {
    sha256: SHA256_HEX,
  },
};

const fieldsOf = (data: unknown): object => (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {});

@Schema(CREATE_UPLOAD_SCHEMA)
export class CreateUploadDto {
  public name: string;
  public size: number;
  /** Hex sha-256 of the whole file. */
  public sha256?: string;
  public partSize?: number;
  public metadata?: Record<string, unknown>;

  constructor(data?: unknown) {
    Object.assign(this, fieldsOf(data));
  }
}

@Schema(COMPLETE_UPLOAD_SCHEMA)
export class CompleteUploadDto {
  public sha256?: string;

  constructor(data?: unknown) {
    Object.assign(this, fieldsOf(data));
  }
}
