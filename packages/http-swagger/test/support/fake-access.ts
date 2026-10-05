/**
 * Test-only `@Access`: writes the descriptor the way `@spinajs/authz-http` shapes it, through the
 * same global symbols http-swagger reads, so the server suites need no authz-http.
 */
const ACCESS_DESCRIPTOR = Symbol.for('authz:access');
const ACCESS_CLASS = Symbol.for('authz:access:class');

interface Descriptor {
  Access: Map<string | symbol, { permissions: string[]; options: { domain?: string } }>;
  Anonymous: Map<string | symbol, true>;
  Unscoped: Map<string | symbol, string>;
  UnfilteredInput: Map<string | symbol, string>;
}

function own(target: any): Descriptor {
  const proto = target.prototype ?? target;
  let d: Descriptor | undefined = Reflect.getOwnMetadata(ACCESS_DESCRIPTOR, proto);
  if (!d) {
    d = { Access: new Map(), Anonymous: new Map(), Unscoped: new Map(), UnfilteredInput: new Map() };
    Reflect.defineMetadata(ACCESS_DESCRIPTOR, d, proto);
  }
  return d;
}

export function access(permission: string | string[], options: { domain?: string } = {}) {
  return (target: any, key?: string | symbol) => {
    own(target).Access.set(key ?? ACCESS_CLASS, { permissions: typeof permission === 'string' ? [permission] : permission, options });
  };
}

export function allowAnonymous() {
  return (target: any, key?: string | symbol) => {
    own(target).Anonymous.set(key ?? ACCESS_CLASS, true);
  };
}
