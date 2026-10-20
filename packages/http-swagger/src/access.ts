import type { IAuthzResource } from './interfaces.js';

/**
 * Reads what `@spinajs/authz-http` writes through its global symbols instead of importing it:
 * the barrel registers `PrincipalMiddleware`, which boots the authz domain with the server and
 * stops the server when that fails, so a swagger app without authz would break.
 * `swaggerAccess` of authz-http returns the same value (the snapshot test keeps them equal).
 */
const ACCESS_DESCRIPTOR = Symbol.for('authz:access');
const ACCESS_CLASS = Symbol.for('authz:access:class');
const EXTRACTOR = Symbol.for('authz:access:extractor');

type AccessKey = string | symbol;

interface AccessRule {
  permissions: readonly string[];
  options: { resource?: unknown; domain?: string };
}

interface AccessDescriptor {
  Access: Map<AccessKey, AccessRule>;
  Anonymous: Map<AccessKey, true>;
  Unscoped: Map<AccessKey, string>;
  UnfilteredInput: Map<AccessKey, string>;
}

interface ExtractorInfo {
  type?: string;
  from?: 'param' | 'body' | 'query' | 'model';
  name?: string;
  by?: string;
  model?: { name: string };
}

export interface SwaggerAccess {
  'x-authz-permission': string[];
  'x-authz-controller-permission'?: string[];
  'x-authz-resource': IAuthzResource;
  'x-authz-domain'?: string;
  'x-authz-anonymous'?: true;
  'x-authz-unscoped'?: string;
  'x-authz-unfiltered-input'?: string;
}

const IN = { param: 'path', body: 'body', query: 'query' } as const;

function resourceOf(rule: AccessRule): IAuthzResource {
  const extractor = rule.options.resource;
  if (!extractor) {
    const first = rule.permissions[0] ?? '';
    const colon = first.indexOf(':');
    return { type: colon < 0 ? first : first.slice(0, colon) };
  }

  const info = (extractor as Record<symbol, ExtractorInfo | undefined>)[EXTRACTOR];
  if (!info) return {};
  if (info.from === 'model') return { in: 'path', name: info.name, model: info.model?.name };
  return {
    ...(info.type !== undefined ? { type: info.type } : {}),
    ...(info.from ? { in: IN[info.from] } : {}),
    ...(info.name !== undefined ? { name: info.name } : {}),
    ...(info.by !== undefined ? { by: info.by } : {}),
  };
}

/** The `x-authz-*` extensions of a route; undefined when no `@Access` guards it. */
export function swaggerAccess(controller: object, method: AccessKey): SwaggerAccess | undefined {
  const proto = typeof controller === 'function' ? (controller as { prototype: object }).prototype : controller;
  const d = Reflect.getMetadata(ACCESS_DESCRIPTOR, proto) as AccessDescriptor | undefined;
  if (!d) return undefined;

  const route = d.Access.get(method);
  const controllerRule = d.Access.get(ACCESS_CLASS);
  const rule = route ?? controllerRule;
  if (!rule) return undefined;

  const anonymous = d.Anonymous.has(method) || d.Anonymous.has(ACCESS_CLASS);
  const unscoped = d.Unscoped.get(method);
  const unfiltered = d.UnfilteredInput.get(method) ?? d.UnfilteredInput.get(ACCESS_CLASS);
  const domain = rule.options.domain;

  return {
    'x-authz-permission': [...rule.permissions],
    ...(route && controllerRule ? { 'x-authz-controller-permission': [...controllerRule.permissions] } : {}),
    'x-authz-resource': resourceOf(rule),
    ...(domain !== undefined && domain !== 'root' ? { 'x-authz-domain': domain } : {}),
    ...(anonymous ? { 'x-authz-anonymous': true as const } : {}),
    ...(unscoped !== undefined ? { 'x-authz-unscoped': unscoped } : {}),
    ...(unfiltered !== undefined ? { 'x-authz-unfiltered-input': unfiltered } : {}),
  };
}

const code = (s: string) => `\`${s}\``;

/** E.g. ``**Access:** requires `a:read` or `a:list` on `user` (path `uuid`)``. */
export function accessLine(access: SwaggerAccess): string {
  const r = access['x-authz-resource'];
  const where = r.model ? `model ${code(r.model)}` : r.in && r.name ? `${r.in} ${code(r.name)}` : '';
  const on = r.type ? ` on ${code(r.type)}${where ? ` (${where})` : ''}` : where ? ` on ${where}` : '';
  const narrowed = access['x-authz-controller-permission'];
  return (
    `**Access:** requires ${access['x-authz-permission'].map(code).join(' or ')}${on}` +
    (narrowed ? `, and the controller requires ${narrowed.map(code).join(' or ')}` : '') +
    (access['x-authz-anonymous'] ? ' (anonymous allowed)' : '')
  );
}
