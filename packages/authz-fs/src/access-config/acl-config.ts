import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { isStringArray } from '@spinajs/util';

import { show } from '../checks.js';

// Not under authz.fs: that section is keyed by filesystem name.
export const FS_ACL_CONNECTION_KEY = 'authz.fsAcl.connection';
export const FS_ACL_DEFAULT_CONNECTION = 'default';
/** The relation of the row owner stamping writes. */
export const FS_ACL_OWNER = 'owner';
export const FS_ACL_DEFAULT_RELATIONS: readonly string[] = Object.freeze([FS_ACL_OWNER, 'editor', 'viewer']);
/** fs_acl.relation holds this many characters. */
export const FS_ACL_RELATION_MAX_LENGTH = 64;

/** `authz.fsAcl` (fs middleware design §2). */
export interface FsAclConfig {
  /** ORM connection of OrmFileAclStore and of its migration. */
  readonly connection: string;
  /** The relations an ACL row may name; FsResourceAdapter serves a RelationResolver for each on fs, dir and file. */
  readonly relations: readonly string[];
}

/**
 * `authz.fsAcl` of the Configuration in `container`, defaults filled; without a Configuration the defaults (the
 * migration reads the connection before any is resolved). `owner` is always among the relations, first: owner
 * stamping writes it whatever the config lists.
 * @throws AuthzConfigError for a malformed value no schema checked
 */
export function fsAclConfig(container: IContainer = DI.RootContainer): FsAclConfig {
  const configuration = container.get(Configuration) as Configuration | undefined;
  const read = (key: string): unknown => (configuration && typeof configuration.get === 'function' ? configuration.get<unknown>(['authz', 'fsAcl', key]) : undefined);
  const connection = read('connection') ?? FS_ACL_DEFAULT_CONNECTION;
  if (typeof connection !== 'string' || connection === '') throw new AuthzConfigError(`${FS_ACL_CONNECTION_KEY} must be a non-empty string, got ${show(connection)}`);
  const relations = read('relations') ?? FS_ACL_DEFAULT_RELATIONS;
  if (!isStringArray(relations, { nonEmpty: true }) || !relations.every((r) => r.length <= FS_ACL_RELATION_MAX_LENGTH)) {
    throw new AuthzConfigError(`authz.fsAcl.relations must be a list of relation names of 1-${FS_ACL_RELATION_MAX_LENGTH} characters, got ${show(relations)}`);
  }
  return Object.freeze({ connection, relations: Object.freeze([...new Set([FS_ACL_OWNER, ...relations])]) });
}
