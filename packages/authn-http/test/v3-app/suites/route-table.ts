import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { BaseController } from '@spinajs/http';
import { Controllers, ServerMiddleware } from '@spinajs/http';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { MemorySessionStore, SessionProvider } from '@spinajs/authn-session';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** METHOD /path of every route the mounted controllers serve. */
export async function mountedRoutes(): Promise<string[]> {
  const listed = await (DI.get(Controllers) as Controllers).Controllers;
  const out: string[] = [];
  for (const ci of listed) {
    const stack = ((ci.instance as BaseController | undefined)?.Router as unknown as { stack?: Layer[] } | undefined)?.stack ?? [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const [method, on] of Object.entries(layer.route.methods)) if (on) out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out;
}

export const ACCOUNT_ROUTES_V3 = [
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth',
  'POST /auth/mfa/verify',
  'POST /auth/mfa/recovery',
  'GET /user/sessions',
  'DELETE /user/sessions/:handle',
  'DELETE /user/sessions',
  'GET /auth/active-role',
  'POST /auth/active-role',
  'GET /auth/impersonate',
  'POST /auth/impersonate',
  'DELETE /auth/impersonate',
];

export function routeTableSuite(): void {
  it('the wiring is the N8c one: AuthnMiddleware without the 2.x middlewares, and authn-session the only session store', async () => {
    const names = (DI.getRegisteredTypes(ServerMiddleware) ?? []).map((t) => t.name);
    expect(names).to.include.members(['ClientIp', 'CsrfOriginGuard', 'AuthnMiddleware']);
    expect(names).to.not.include.members(['RbacMiddleware', 'TokenAuthMiddleware']);
    expect(DI.getRegisteredTypes(SessionProvider)).to.deep.eq([MemorySessionStore]);
    const issuer = (await DI.resolve(SessionIssuer)) as unknown as { Store: unknown };
    expect(issuer.Store).to.be.instanceOf(MemorySessionStore);
  });

  it('the test wiring mounts every 3.0 account route and registers no method and path twice', async () => {
    const routes = await mountedRoutes();
    expect(routes).to.include.members(ACCOUNT_ROUTES_V3);
    const twice = routes.filter((r, i) => routes.indexOf(r) !== i);
    expect(twice, routes.join('\n')).to.deep.eq([]);
  });
}
