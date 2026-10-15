import 'mocha';

import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, AuthzService, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { AuthzAdminIdempotency_2026_10_02_00_01_00, AuthzRbac_2026_10_01_00_00_00, RBAC_SERVICE_NAME, RbacService, registerRbac } from '@spinajs/authz-rbac';
import { CLIENT_ACCESS_FIXTURE, runClientAccessConformance, testHost } from '@spinajs/authz-testing';
import type { ClientAccessApp } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

import { AccessResource, AuthzResourceAncestor_2026_10_14_00_00_00 } from '@spinajs/authz-orm';
import { TestDb } from './support/db.js';
import { E2eAdminBackend } from './support/stack.js';
// authz-http's own test app and header principal source (x-user: <id>). They load authz-http from its src, so this
// file does too: the built '@spinajs/authz-http' would be a second copy with its own PrincipalSource and middlewares.
import { Access, AccessController } from '../../../authz-http/src/index.js';
import { startApp, stopApp } from '../../../authz-http/test/support/app.js';
import { registerHeaderSource } from '../../../authz-http/test/support/principals.js';

let Doc: { query(): any; insert(v: unknown): any };

@BasePath('docs')
class DocsController extends BaseController {
  @Get('/')
  @Access('doc:view')
  public async list() {
    const rows = (await Doc.query().accessible('doc:view').withAccess(['doc:edit', 'doc:view'])) as { id: string; $access: unknown }[];
    return new Ok(rows.map((r) => ({ id: r.id, $access: r.$access })));
  }
}

type RootRegistry = Map<string, unknown[]>;
const rootRegistry = (): RootRegistry => (DI.RootContainer.Registry as unknown as { registry: RootRegistry }).registry;

/**
 * Runs `register` and returns its undo. registerRbac writes into the root container directly, and the child domains
 * of the e2e suites that run later chain root's models, so its registrations must not outlive this app.
 */
async function rootRegistrations(register: () => Promise<void>): Promise<() => void> {
  const before = new Map([...rootRegistry()].map(([k, v]) => [k, [...v]]));
  await register();
  const added = [...rootRegistry()].flatMap(([k, v]) => v.filter((e) => !(before.get(k) ?? []).includes(e)).map((e) => [k, e] as const));
  return () => {
    for (const [key, entry] of added) {
      const list = rootRegistry().get(key);
      const i = list?.indexOf(entry) ?? -1;
      if (i >= 0) list!.splice(i, 1);
      if (list?.length === 0) rootRegistry().delete(key);
      if (typeof entry === 'function' && entry.prototype !== undefined) DI.uncache(entry as Class<unknown>);
    }
    for (const token of [AuthorizationModel, AuthzContributor, RbacService, AuthzAdminBackend] as Class<unknown>[]) DI.uncache(token);
    DI.uncache(RBAC_SERVICE_NAME);
  };
}

async function startClientApp(): Promise<ClientAccessApp> {
  // As authz-http's test setup: the http config sources would otherwise load a CommonJS copy of @spinajs/di.
  DI.setESMModuleSupport();
  const db = await TestDb.open();
  const driver = db.driver('sqlite');
  for (const m of [new AuthzRbac_2026_10_01_00_00_00(), new AuthzAdminIdempotency_2026_10_02_00_01_00(), new AuthzResourceAncestor_2026_10_14_00_00_00()]) await m.up(driver);
  Doc = (await db.define({ name: 'Doc', columns: {}, decorate: (m) => AccessResource('doc')(m) })) as never;
  for (const id of CLIENT_ACCESS_FIXTURE.ids) await runWithPrincipal(SYSTEM, async () => void (await Doc.insert({ id })));

  const cfg = testHost.config();
  const config: Record<string, unknown> = {
    'process.env.APP_ENV': 'test',
    'authz.permissions': { ...CLIENT_ACCESS_FIXTURE.permissions, 'authz:assignments.manage': { types: ['doc'] } },
    // Whole: the installed packages' defaults add ladders and service roles over roles the fixture's replace.
    'authz.rbac': { roles: CLIENT_ACCESS_FIXTURE.roles, stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] }, connection: 'sqlite' },
    'authz.admin': { connection: 'sqlite', backend: 'E2eAdminBackend', guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage' } },
    'authz.combine': { default: { algorithm: 'deny-overrides', models: ['rbac'] } },
    // startApp replaces the whole configuration with the package defaults, TestDb's connections included.
    db: cfg.get<unknown>('db'),
  };
  // The root domain boots once the server listens, inside startApp, so RBAC must be registered before it.
  for (const [path, value] of Object.entries(config)) cfg.set(path.split('.'), value);
  const unregisterRbac = await rootRegistrations(async () => {
    await registerRbac(DI.RootContainer, cfg);
    DI.register(E2eAdminBackend).as(AuthzAdminBackend);
  });
  const unregisterSource = registerHeaderSource();

  const stop = async () => {
    try {
      await stopApp();
    } finally {
      unregisterSource();
      unregisterRbac();
      await db.close();
    }
  };

  try {
    const app = await startApp({ controllers: [AccessController, DocsController], config });
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    const grants = CLIENT_ACCESS_FIXTURE.assignments.map((a) => ({ kind: 'assignment.grant' as const, subject: a.subject, role: a.role, scope: a.scope }));
    const results = await authz.admin().execute(SYSTEM, grants);
    if (!results.every((r) => r.ok)) throw new Error(`client app: seeding failed ${JSON.stringify(results)}`);

    return {
      baseUrl: `http://127.0.0.1:${app.port}`,
      headers: (id): Record<string, string> => (id ? { 'x-user': id } : {}),
      async assign(id, role, scope) {
        const [r] = await authz.admin().execute(SYSTEM, [{ kind: 'assignment.grant', subject: { type: 'user', id }, role, scope }]);
        if (!r.ok) throw new Error(`assign: ${JSON.stringify(r)}`);
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

runClientAccessConformance('client access conformance: authz-http + authz-orm + RBAC (sqlite)', startClientApp);
