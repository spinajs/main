import { isPermission, parsePermission } from '@spinajs/authz';
import type { DecisionRequest, Principal, ResourceRef } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';

export interface ExplainRequestInput {
  readonly principal: unknown;
  readonly permission: unknown;
  readonly resource?: unknown;
}

function splitKey(raw: unknown, what: string): { type: string; id?: string } {
  const key: string = _check_arg(_is_string(_non_empty()))(raw, what);
  const at = key.indexOf(':');
  const rawType = at < 0 ? key : key.slice(0, at);
  const id = at < 0 ? undefined : key.slice(at + 1);
  // principalKey escapes '%' and ':' in the type part only.
  const type = rawType.replace(/%3A/gi, ':').replace(/%25/g, '%');
  if (type === '' || id === '') throw new InvalidArgument(`${what} must be <type>:<id>`, what);
  return id === undefined ? { type } : { type, id };
}

/**
 * The decision request an explain call asks about: `principal` as `<type>:<id>`, `resource` as `<type>[:<id>]`
 * (default: the permission's resource type). Shared by `GET /authz/explain` and Spina Studio.
 */
export function resolveExplainRequest(input: ExplainRequestInput): DecisionRequest {
  const target = splitKey(input.principal, 'principal');
  if (target.id === undefined) throw new InvalidArgument('principal must be <type>:<id>', 'principal');
  const permission: string = _check_arg(_is_string(_non_empty()))(input.permission, 'permission');
  if (!isPermission(permission)) throw new InvalidArgument('permission must be <resource>:<action>', 'permission');

  const resource: ResourceRef = input.resource === undefined || input.resource === '' ? { type: parsePermission(permission).resource } : splitKey(input.resource, 'resource');
  const principal: Principal = Object.freeze({ type: target.type, id: target.id, authenticated: target.type !== 'anonymous' && target.type !== 'unattended', source: 'explain', attributes: Object.freeze({}) });
  return { principal, permission, resource };
}
