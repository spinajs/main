import { PERMISSION_PATTERN } from '@spinajs/authz';
import { registerConfigurationSchema } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { FS_METADATA_DEFAULT_CONNECTION } from '../metadata/connection.js';
import { FS_RESOURCE_TYPES } from '../refs/index.js';

const name = { type: 'string', minLength: 1 };
// The name part of PERMISSION_PATTERN (^name:name$).
const ACTION = PERMISSION_PATTERN.source.slice(1, -1).split(':')[0];
const permission = { type: 'string', pattern: PERMISSION_PATTERN.source };

// propertyNames refuses an unknown key; additionalProperties: false would let removeAdditional drop a typo silently.
const closed = (properties: Record<string, unknown>, required?: string[]) => ({ type: 'object', properties, propertyNames: { enum: Object.keys(properties) }, ...(required ? { required } : {}) });

// The fs-abac model checks the rest of a policy when it loads it.
const policy = {
  type: 'object',
  properties: {
    permissions: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^fs:' } },
    resourceTypes: { type: 'array', items: { type: 'string', enum: [...FS_RESOURCE_TYPES] } },
  },
  required: ['permissions'],
};

const entry = {
  ...closed(
    {
      mode: { type: 'string', enum: ['off', 'audit', 'enforce'] },
      domain: name,
      metadata: name,
      stampOwner: { type: 'boolean' },
      resolver: name,
      // fs-inherit checks `<parent type>:<action>`, so the action alone must complete a permission name.
      inherit: { type: 'object', propertyNames: { pattern: `^fs:${ACTION}$` }, additionalProperties: { type: 'string', pattern: `^${ACTION}$` } },
      signedUrl: closed({ maxTtlSeconds: { type: 'number', exclusiveMinimum: 0 }, defaultTtlSeconds: { type: 'number', exclusiveMinimum: 0 } }),
      policies: { type: 'array', items: policy },
      operations: { type: 'object', propertyNames: { not: { enum: ['__proto__', 'constructor', 'prototype'] } }, additionalProperties: { anyOf: [permission, { type: 'array', minItems: 1, items: permission }] } },
      list: { type: 'string', enum: ['dir', 'each'] },
    },
    // A present entry says its mode: one with policies but no mode must not be silently off.
    ['mode'],
  ),
  // The owners live in the FileMetadataStore that `metadata` names.
  if: { properties: { stampOwner: { enum: [true, 'true', 1] } }, required: ['stampOwner'] },
  then: { required: ['metadata'] },
};

/** `authz.fs.<filesystem>` (design §13): one entry per filesystem name; a filesystem without one is off. */
export const AUTHZ_FS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs.configuration.schema.json',
  $configurationModule: 'authz.fs',
  description: 'Filesystem access configuration (authz.fs.<filesystem>)',
  type: 'object',
  additionalProperties: entry,
};

export const AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs-metadata.configuration.schema.json',
  // Not under authz.fs: that section is keyed by filesystem name.
  $configurationModule: 'authz.fsMetadata',
  description: 'File metadata store configuration (authz.fsMetadata.*)',
  type: 'object',
  properties: { connection: { ...name, default: FS_METADATA_DEFAULT_CONNECTION } },
};

@Injectable(Bootstrapper)
export class AuthzFsConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_FS_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_FS_METADATA_CONFIGURATION_SCHEMA);
  }
}
