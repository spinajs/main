import { UPLOAD_MAX_PART_BYTES } from './constants.js';
import { DURATION_PATTERN, POSITIVE_DURATION_PATTERN } from './duration.js';

const POSITIVE = { type: 'integer', minimum: 1 };
const DURATION = { type: 'string', pattern: DURATION_PATTERN };
const POSITIVE_DURATION = { type: 'string', pattern: POSITIVE_DURATION_PATTERN };
const DIGEST_POLICY = { type: 'string', enum: ['required', 'optional'], default: 'required' };
const PROVIDER = { type: 'string', minLength: 1 };

/**
 * The `upload` module (spec §6.2); Ajv fills the defaults and refuses a wrong value at boot (configuration/src/configuration.ts:640-650).
 * Every default lives here, not in the shipped config: config files concatenate arrays (configuration/src/util-common.ts:23-27).
 */
export const UPLOAD_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/upload.configuration.schema.json',
  $configurationModule: 'upload',
  description: 'Resumable upload configuration (upload)',
  type: 'object',
  properties: {
    fs: {
      type: 'object',
      default: {},
      properties: {
        temp: { ...PROVIDER, default: 'upload-temp', description: 'fs.providers name for parts' },
        files: { ...PROVIDER, default: 'upload-files', description: 'fs.providers name for merged files' },
        prefix: { type: 'string', pattern: '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$', default: 'uploads' },
      },
    },
    limits: {
      type: 'object',
      default: {},
      properties: {
        maxFileSize: { ...POSITIVE, default: 1_073_741_824 },
        partSize: { ...POSITIVE, default: 8_388_608 },
        minPartSize: { ...POSITIVE, default: 1_048_576 },
        maxPartSize: { ...POSITIVE, maximum: UPLOAD_MAX_PART_BYTES, default: 67_108_864 },
        maxParts: { ...POSITIVE, default: 10_000 },
        maxOpenSessionsPerOwner: { ...POSITIVE, default: 20 },
        sessionTtl: { ...POSITIVE_DURATION, default: '24h' },
      },
    },
    integrity: {
      type: 'object',
      default: {},
      properties: {
        partDigest: DIGEST_POLICY,
        fileDigest: DIGEST_POLICY,
      },
    },
    detect: {
      type: 'object',
      default: {},
      properties: {
        headBytes: { ...POSITIVE, default: 4100 },
        allowUndetected: { type: 'array', items: { type: 'string', minLength: 1 }, default: ['text/plain', 'text/csv'] },
      },
    },
    assembly: {
      type: 'object',
      default: {},
      properties: {
        staleAfter: { ...POSITIVE_DURATION, default: '30m' },
      },
    },
    sweeper: {
      type: 'object',
      default: {},
      properties: {
        every: { ...POSITIVE_DURATION, default: '15m' },
        retainFinished: { ...DURATION, default: '7d' },
        batch: { ...POSITIVE, default: 200 },
      },
    },
  },
};
