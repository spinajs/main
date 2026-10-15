import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chai from 'chai';
import chaiHttp from 'chai-http';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthorizationModel, AuthzContributor, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AbacContributor, AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { PrincipalSource } from '@spinajs/authz-http';
// Importing authz-orm also registers the list helpers and the ancestor table maintenance (QueryMiddleware).
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { registerRbac } from '@spinajs/authz-rbac';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { InvitationMailer, VerifiedEmailSource } from '@spinajs/teams';
import type { InvitationMail } from '@spinajs/teams';

import { TEAMS_HTTP_CONTROLLERS } from '../../src/controller-list.js';

chai.use(chaiHttp);

export const USER_HEADER = 'x-user';
export const EMAIL_HEADER = 'x-user-email';

const INVITATION_SECRET = 'teams-http-test-invitation-secret-0123456789abcdef';
const LINK_SECRET = 'teams-http-test-link-secret-0123456789abcdef';

/**
 * `x-user: <id>` is the authenticated `user:<id>`; `x-user-email` gives it a verified email in the
 * attributes L14's default VerifiedEmailSource reads. Without `x-user` this source yields nothing.
 */
class HeaderPrincipalSource extends PrincipalSource {
  public readonly name = 'teams-http-test';
  public readonly order = 0;

  public async authenticate(req: Request): Promise<Principal | null> {
    const id = req.headers[USER_HEADER];
    if (typeof id !== 'string' || id.length === 0) return null;
    const email = req.headers[EMAIL_HEADER];
    return userPrincipal(id, typeof email === 'string' && email.length > 0 ? { attributes: { email, emailVerified: true } } : {});
  }
}

/** Keeps invitation mail off the wire; the cases read the mails, tokens included. */
export class RecordingInvitationMailer extends InvitationMailer {
  public static readonly sent: InvitationMail[] = [];

  public async send(mail: InvitationMail): Promise<void> {
    RecordingInvitationMailer.sent.push(mail);
  }
}

/** What an app registers (teams ships none); the same rule as L14's test AttributesEmailSource. */
class AttributesEmailSource extends VerifiedEmailSource {
  public async verifiedEmail(principal: Principal): Promise<string | undefined> {
    const a = principal.attributes ?? {};
    return a.emailVerified === true && typeof a.email === 'string' ? a.email : undefined;
  }
}

/**
 * The package defaults of every installed @spinajs package, as an app loads them, with this test's
 * database and secrets. `test.platform` at $global is how a case gets a user who may create root teams.
 */
class TeamsHttpTestConfiguration extends FrameworkConfiguration {
  public async load(): Promise<void> {
    await super.load();
    // Set after the defaults merged: they list the controller dirs of every installed package.
    this.set(['system', 'dirs', 'controllers'], []);
    this.set(['http', 'port'], 0);
    const providers = (this.get<{ name?: string }[]>(['fs', 'providers']) ?? []).filter((p) => p.name !== '__fs_controller_cache__');
    this.set(['fs', 'providers'], [...providers, { service: 'fsNative', name: '__fs_controller_cache__', basePath: join(tmpdir(), 'spinajs-teams-http-test-cache') }]);
    // The env authz-orm's runtime guard reads: 'test' makes an unscoped multi-row select throw.
    this.set(['process', 'env', 'APP_ENV'], 'test');
    // Only the teams fragment's roles and test.platform: other installed packages ship roles over permissions their
    // resource adapters declare (users: user:impersonate), this app loads none of them, and the engine refuses to
    // boot on an unknown permission or a service role naming a dropped role.
    const roles = this.get<Record<string, unknown>>(['authz', 'rbac', 'roles']) ?? {};
    this.set(['authz', 'rbac', 'roles'], Object.fromEntries(Object.entries(roles).filter(([name]) => /^(team|group|test)\./.test(name))));
    this.set(['authz', 'rbac', 'serviceRoles'], {});
  }

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authz: {
        // AuthzAdmin checks it for the SYSTEM seeds at $global; the teams fragment maps only team and group scopes.
        permissions: { 'authz:assignments.manage': {} },
        admin: {
          backend: 'DbAuthzAdminBackend',
          connection: 'default',
          guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
        },
        rbac: {
          connection: 'default',
          stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
          links: { secret: LINK_SECRET },
          roles: { 'test.platform': { grants: ['team:create'], scopeTypes: ['$global'] } },
        },
      },
      teams: { invitations: { secret: INVITATION_SECRET } },
      queue: { default: 'teams-http-test-queue', connections: [{ service: 'BlackHoleQueueClient', name: 'teams-http-test-queue' }] },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } },
          },
        ],
      },
    };
  }
}

let running: { readonly server: HttpServer; readonly port: number } | undefined;

/**
 * Boots one http server for the whole run: real root authz (RBAC with config roles, assignments in
 * SQLite, DbAuthzAdminBackend, authz-orm list helpers), L14's services, fragment and migrations,
 * every teams-http controller, and the `x-user` principal source. Started and stopped by test/hooks.ts.
 */
export async function startTeamsApp(): Promise<number> {
  if (running) return running.port;

  DI.register(TeamsHttpTestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  DI.register(HeaderPrincipalSource).as(PrincipalSource);
  DI.register(RecordingInvitationMailer).as(InvitationMailer);
  DI.register(AttributesEmailSource).as(VerifiedEmailSource);

  for (const b of (await DI.resolve(Array.ofType(Bootstrapper))) as Bootstrapper[]) {
    await b.bootstrap();
  }
  const config = (await DI.resolve(Configuration)) as Configuration;
  // Before anything resolves the root AuthzService, whose boot reads the models and stores registered here.
  const root = DI.RootContainer;
  const attributes = new DbScopeAttributeStore({ container: root });
  root.register(testHost.instance(attributes)).as(ScopeAttributeStore);
  root.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
  const abac = new AbacModel({ stores: [new ConfigPolicyStore(config.get<unknown[]>(['authz', 'abac', 'policies'], []))] });
  root.register(testHost.instance(abac)).as(AuthorizationModel);
  root.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
  await registerRbac(root, config);
  await DI.resolve(fsService);
  await DI.resolve(Orm);

  for (const c of TEAMS_HTTP_CONTROLLERS) DI.register(c as Class<BaseController>).as(BaseController);
  await DI.resolve(Controllers);
  const server = (await DI.resolve(HttpServer)) as HttpServer;
  await server.start();

  running = { server, port: (server.Server.address() as AddressInfo).port };
  return running.port;
}

export async function stopTeamsApp(): Promise<void> {
  if (!running) return;
  const { server } = running;
  running = undefined;
  await server.stop();
  await ((await DI.resolve(Orm)) as Orm).dispose();
}

export function appPort(): number {
  if (!running) throw new Error('teams-http test app is not running (test/hooks.ts starts it)');
  return running.port;
}
