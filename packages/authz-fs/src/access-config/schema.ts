import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { FS_ACL_DEFAULT_CONNECTION, FS_ACL_DEFAULT_RELATIONS, FS_ACL_RELATION_MAX_LENGTH } from './acl-config.js';

const name = { type: 'string', minLength: 1 };

// propertyNames refuses an unknown key; additionalProperties: false would let removeAdditional drop a typo silently.
const closed = (properties: Record<string, unknown>, required?: string[]) => ({ type: 'object', properties, propertyNames: { enum: Object.keys(properties) }, ...(required ? { required } : {}) });

const entry = closed(
  {
    mode: { type: 'string', enum: ['off', 'audit', 'enforce'] },
    domain: name,
    stampOwner: { type: 'boolean' },
    signedUrl: closed({ maxTtlSeconds: { type: 'number', exclusiveMinimum: 0 }, defaultTtlSeconds: { type: 'number', exclusiveMinimum: 0 } }),
    list: { type: 'string', enum: ['dir', 'each'] },
  },
  // A present entry says its mode: an entry with other keys but no mode must not be silently off.
  ['mode'],
);

/** `authz.fs.<filesystem>`: one entry per filesystem name; a filesystem without one is off. */
export const AUTHZ_FS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs.configuration.schema.json',
  $configurationModule: 'authz.fs',
  description: 'Filesystem access configuration (authz.fs.<filesystem>)',
  type: 'object',
  additionalProperties: entry,
};

export const AUTHZ_FS_ACL_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-fs-acl.configuration.schema.json',
  // Not under authz.fs: that section is keyed by filesystem name.
  $configurationModule: 'authz.fsAcl',
  description: 'File ACL configuration (authz.fsAcl.*)',
  ...closed({
    connection: { ...name, default: FS_ACL_DEFAULT_CONNECTION },
    relations: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: FS_ACL_RELATION_MAX_LENGTH }, default: [...FS_ACL_DEFAULT_RELATIONS] },
  }),
};

registerConfigurationSchemaAtImport(AUTHZ_FS_CONFIGURATION_SCHEMA);
registerConfigurationSchemaAtImport(AUTHZ_FS_ACL_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzFsConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_FS_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_FS_ACL_CONFIGURATION_SCHEMA);
  }
}
