import { AuthorizationModel, AuthzContributor, AuthzEventSink, AuthzService, ScopeAttributeStore, WritableScopeAttributeStore } from '@spinajs/authz';
import type { AuthzAdmin, AuthzEvent, Principal } from '@spinajs/authz';
import { AbacContributor, AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { DbScopeAttributeStore } from '@spinajs/authz-orm';
import { registerRbac } from '@spinajs/authz-rbac';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import teamsConfig from '../../src/config/teams.js';
import { InvitationMailer, VerifiedEmailSource } from '../../src/index.js';
import type { InvitationMail } from '../../src/index.js';
import { teamsDb } from './db.js';
import type { TeamsDb } from './db.js';

export const INVITATION_SECRET = 'teams-test-invitation-secret-of-at-least-32-chars';

type TestConfiguration = ReturnType<typeof testHost.config>;

export class RecordingEventSink extends AuthzEventSink {
  readonly events: AuthzEvent[] = [];

  async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

/** What an app registers: teams ships no VerifiedEmailSource. */
export class AttributesEmailSource extends VerifiedEmailSource {
  async verifiedEmail(principal: Principal): Promise<string | undefined> {
    const a = principal.attributes ?? {};
    return a.emailVerified === true && typeof a.email === 'string' ? a.email : undefined;
  }
}

export class RecordingInvitationMailer extends InvitationMailer {
  readonly sent: InvitationMail[] = [];
  fail = false;

  async send(mail: InvitationMail): Promise<void> {
    if (this.fail) throw new Error('mail transport down');
    this.sent.push(mail);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The configuration merge: objects deep, arrays concatenated. */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    const cur = out[k];
    if (Array.isArray(cur) && Array.isArray(v)) out[k] = [...cur, ...v];
    else if (isRecord(cur) && isRecord(v)) out[k] = deepMerge(cur, v);
    else out[k] = structuredClone(v);
  }
  return out;
}

/** What an app adds to the fragment: stores, the guard, a role that may create root teams, rights on an app type, the invitation secret. */
export const TEST_CONFIG = {
  teams: { membership: { subTeamsInParent: true }, deletion: { graceDays: 30 }, invitations: { secret: INVITATION_SECRET, defaultTtlHours: 168, subject: 'You are invited to join a team' } },
  authz: {
    // project:* declare team: team roles grant them at a team, where the admin guard checks them.
    permissions: { 'authz:assignments.manage': {}, 'project:read': { types: ['project', 'team'] }, 'project:update': { types: ['project', 'team'] } },
    rbac: {
      connection: 'default',
      stores: { roles: ['ConfigRoleStore'], assignments: ['DbAssignmentStore'] },
      // grants concatenate with the fragment's: an app giving team roles rights on its own type below the team.
      roles: { 'teams.creator': { grants: ['team:create'], scopeTypes: ['$global'] }, 'team.member': { grants: ['project:read'] }, 'team.admin': { grants: ['project:update'] } },
    },
    admin: {
      connection: 'default',
      backend: 'DbAuthzAdminBackend',
      guard: { service: 'DefaultAdminGuard', privilegedPermission: 'authz:assignments.manage', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true },
    },
  },
};

export interface TeamsStack extends TeamsDb {
  readonly authz: AuthzService;
  readonly admin: AuthzAdmin;
  readonly events: RecordingEventSink;
  readonly mailer: RecordingInvitationMailer;
  readonly config: TestConfiguration;
}

let booted: Promise<TeamsStack> | undefined;

async function boot(): Promise<TeamsStack> {
  const db = await teamsDb();
  const config = testHost.config();
  const merged = deepMerge(deepMerge({}, teamsConfig as unknown as Record<string, unknown>), TEST_CONFIG);
  for (const [k, v] of Object.entries(merged)) config.set(k, v);
  // authz-orm's runtime guard reads the app env here; 'test' makes an unscoped multi-row select throw.
  config.set(['process', 'env', 'APP_ENV'], 'test');

  const root = DI.RootContainer;
  const events = new RecordingEventSink();
  root.register(testHost.instance(events)).as(AuthzEventSink);
  const mailer = new RecordingInvitationMailer();
  root.register(testHost.instance(mailer)).as(InvitationMailer);
  root.register(testHost.instance(new AttributesEmailSource())).as(VerifiedEmailSource);
  const attributes = new DbScopeAttributeStore({ container: root });
  root.register(testHost.instance(attributes)).as(ScopeAttributeStore);
  root.register(testHost.instance(attributes)).as(WritableScopeAttributeStore);
  const abac = new AbacModel({ stores: [new ConfigPolicyStore(config.get<unknown[]>(['authz', 'abac', 'policies'], []))] });
  root.register(testHost.instance(abac)).as(AuthorizationModel);
  root.register(testHost.instance(new AbacContributor(abac))).as(AuthzContributor);
  await registerRbac(root, config);

  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  return { ...db, authz, admin: authz.admin(), events, mailer, config };
}

/** The booted root domain over the shared test database; once per mocha process. */
export function teamsStack(): Promise<TeamsStack> {
  return (booted ??= boot());
}
