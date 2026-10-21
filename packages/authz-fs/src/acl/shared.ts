import { AuthzConfigError } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import type { AssignmentSubject } from '@spinajs/authz-rbac';
import { SUBJECT_KEY_MAX_LENGTH, parsePrincipalKey, parsePrincipalSubjectKey, parseSetKey, principalSubjectKey, subjectKeyOf } from '@spinajs/authz-rbac';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { normalizeFsPath } from '@spinajs/fs';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';
import { sha256 } from '@spinajs/util/crypto';

import { checkFsName } from '../checks.js';
import { FileAclStore } from './store.js';

// Internal to the ACL stores, the relation and the middleware; the barrel exports the two constants only.

export const FS_ACL_TABLE = 'fs_acl';

export const FS_ACL_LIMITS = Object.freeze({ fs: 64, path: 512, subject_key: SUBJECT_KEY_MAX_LENGTH, relation: 64, granted_by: 100 });

type Column = keyof typeof FS_ACL_LIMITS;

export function fits(value: string, column: Column): string {
  if (value.length > FS_ACL_LIMITS[column]) throw new InvalidArgument(`${JSON.stringify(value.slice(0, 40))}… does not fit ${FS_ACL_TABLE}.${column} (${FS_ACL_LIMITS[column]} characters)`, column);
  return value;
}

export const aclFs = (fs: unknown): string => fits(checkFsName(fs), 'fs');

export const aclPath = (path: string): string => fits(normalizeFsPath(path), 'path');

/** `fs_acl.path_hash`: keeps the unique key short enough for every driver (path alone is 2048 bytes in MySQL utf8mb4). */
export const aclPathHash = (normalised: string): string => sha256(normalised);

export const aclRelation = (relation: unknown): string => fits(_check_arg(_is_string(_non_empty()))(relation, 'relation') as string, 'relation');

export const aclSubjectKey = (subject: AssignmentSubject): string => fits(subjectKeyOf(subject), 'subject_key');

/** An owner is one principal: its own key, never the type wildcard (a principal whose id is '*' stays itself). */
export function aclOwnerKey(owner: PrincipalRef): string {
  if (owner === null || typeof owner !== 'object' || typeof owner.type !== 'string' || owner.type === '' || typeof owner.id !== 'string' || owner.id === '') {
    throw new InvalidArgument(`an owner is a principal { type, id } with non-empty strings, got ${JSON.stringify(owner)}`, 'owner');
  }
  return fits(principalSubjectKey({ type: owner.type, id: owner.id }), 'subject_key');
}

export function aclExpiry(expiresAt: unknown): Date | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) throw new InvalidArgument(`expiresAt must be a valid Date, got ${String(expiresAt)}`, 'expiresAt');
  return expiresAt;
}

/** `type:*`: every principal of the type. */
export const isWildcardKey = (key: string): boolean => key.endsWith(':*');

/** The subject a stored key names: a set (`type:id#role`), a principal, or a type wildcard. */
export function subjectOfKey(key: string, at: string): AssignmentSubject {
  const subject = (parseSetKey(key) as AssignmentSubject | undefined) ?? parsePrincipalSubjectKey(key) ?? (isWildcardKey(key) ? parsePrincipalKey(key) : undefined);
  if (!subject) throw new AuthzConfigError(`${at}: ${JSON.stringify(key)} is not a subject key`);
  return subject;
}

/** `path`, its parent directories nearest first, then '' (D7: a row on a directory or the root covers what is under it). */
export function aclPathChain(path: string): string[] {
  if (path === '') return [''];
  const segments = path.split('/');
  const chain: string[] = [];
  for (let n = segments.length; n > 0; n--) chain.push(segments.slice(0, n).join('/'));
  chain.push('');
  return chain;
}

export const isUnder = (path: string, root: string): boolean => root === '' || path === root || path.startsWith(`${root}/`);

/** Where `path` (at or under `from`) lands when `from` moves to `to`. */
export function movedPath(from: string, to: string, path: string): string {
  const rest = from === '' ? path : path.slice(from.length + 1);
  if (to === '') return rest;
  return rest === '' ? to : `${to}/${rest}`;
}

export function checkMove(fromFs: string, from: string, toFs: string, to: string): void {
  if (fromFs === toFs && from !== to && (from === '' || to.startsWith(`${from}/`))) throw new InvalidArgument(`cannot move ${fromFs}:${from} into itself (${to})`, 'to');
}

/** The FileAclStore of `container`: the last one registered (OrmFileAclStore unless an app or a test adds one). */
export async function fileAclStore(container: IContainer): Promise<FileAclStore> {
  return (await container.resolve(FileAclStore)) as FileAclStore;
}
