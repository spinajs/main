import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { fromParam } from '@spinajs/authz-http';
import type { ResourceExtractor } from '@spinajs/authz-http';
import type { Request } from '@spinajs/http';

export const TEAM = fromParam('team', 'team');
export const GROUP = fromParam('group', 'group');

/**
 * Where a new team goes: the body's `parentId`, or `$global` for a root team. Not a type-level check: the
 * fragment's `teams.archived.write` denies `*:create` on a team without an id (it fails closed, B19).
 */
export const PARENT_TEAM: ResourceExtractor = (req: Request): ResourceRef => {
  const parentId = (req.body as { parentId?: unknown } | undefined)?.parentId;
  return typeof parentId === 'string' && parentId.length > 0 ? { type: 'team', id: parentId } : GLOBAL;
};
