import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import _ from 'lodash';
import { DefaultQueueService } from '@spinajs/queue';
import { InvalidArgument } from '@spinajs/exceptions';
import { AuthorizationModel, AuthzAdminBackend, AuthzContributor, AuthzEventSink, GLOBAL, MemoryAuthzAdminBackend, SYSTEM } from '@spinajs/authz';
import type { AuthzEvent, AuthzService } from '@spinajs/authz';
import { AdminAssignmentStore, AdminLinkStore, AdminRuleStore, AssignmentStore, ConfigRoleStore, LinkStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRuleStore, RbacContributor, RbacModel, RoleStore, RuleStore } from '@spinajs/authz-rbac';
import type { LadderDef, RoleDef } from '@spinajs/authz-rbac';
import { hostHarness, runBehaviour, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet } from '@spinajs/authz-testing';
import { EnrolledMfaPolicy, FakeAuthnService, FakeBackoffThrottle, MemoryLinkStore as MemoryIdentityLinkStore, MemorySecretStore, RecordingEventSink, RecordingPrincipalFactory, UnsupportedConfig, runAuthnBehaviour, throttleParams } from '@spinajs/authn-testing';
import type { Harness, HarnessContext } from '@spinajs/authn-testing';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Argon2PasswordHasher, LocalPasswordPolicy, LocalPasswordService, LocalPasswordStrategy, PasswordMailer } from '@spinajs/authn-local';
import type { PasswordMail } from '@spinajs/authn-local';

import usersConfig from '../src/config/users.js';
import { QueueAuthnEventSink, UserAccountSink, UserIdentityStore, UserPasswordStore, User } from '../src/index.js';
import { ban, create, deactivate, grant, revoke, setUserMeta } from '../src/actions.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { registerRecordingSessionIssuer } from './support/session-issuer.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags, storedUser } from './support/users-db.js';

/**
 * Plan C1 acceptance. Also part of it, in their own files: authn's identity store conformance
 * (`identity-conformance.test.ts`, sqlite and postgres), SEC1 (`reserved-metadata.test.ts`, and its users side in
 * `lifecycle-authn.test.ts`), and the L1-1 "For C1" cases (`create.test.ts`: a bad `authz.rbac.defaultRoles` fails the
 * root boot; a new user holds its default roles as stored GLOBAL assignments).
 */

const { instance } = testHost;

/** As the configuration loader merges files: arrays are concatenated. */
const mergeArrays = (target: unknown, source: unknown) => (Array.isArray(target) ? target.concat(source) : undefined);

const roleConfig = (roles: readonly RoleDef[]) => Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));
const ladderConfig = (ladders: readonly LadderDef[]) => Object.fromEntries(ladders.map(({ name, ...def }) => [name, def]));

class RecordingAuthzSink extends AuthzEventSink {
  public readonly events: AuthzEvent[] = [];

  public async publish(events: readonly AuthzEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

/** Its own name, so the test domain's backend (and its idempotency keys) is the case's, not root's. */
class UsersAcceptanceBackend extends MemoryAuthzAdminBackend {}

/**
 * The kit's shared host harness (a real `DefaultAuthzService` test domain under root) with authz-rbac's `RbacModel`
 * over `ConfigRoleStore`, and, for the admin parts, `DefaultAuthzAdmin` with authz-rbac's guard defaults. The roles are
 * the world's merged with users' shipped `authz.rbac.roles` fragment, as an application loads both; users' root
 * registrations (the `self` resolvers, `UserResourceAdapter` and its `user:*` permissions) are in the chain.
 */
function usersRbacHarness(admin: boolean): BehaviourHarness {
  return hostHarness({
    facets: ['rbac', ...(admin ? (['admin', 'ladders'] as Facet[]) : [])],
    kitScopeAttributes: false,
    async register(host) {
      const c = host.container;
      const rbac = host.world.rbac ?? {};

      host.setConfig(['authz', 'rbac', 'roles'], _.mergeWith({}, roleConfig((rbac.roles ?? []) as readonly RoleDef[]), usersConfig.authz.rbac.roles, mergeArrays));
      if (rbac.ladders) host.setConfig(['authz', 'rbac', 'ladders'], ladderConfig(rbac.ladders as readonly LadderDef[]));

      const assignments = new MemoryAdminAssignmentStore({ assignments: rbac.assignments });
      const links = new MemoryLinkStore(assignments);
      const rules = new MemoryRuleStore();
      const roles = new ConfigRoleStore((await c.resolve(Configuration)) as Configuration);
      const model = new RbacModel({ roles, assignments, links, clock: host.kit.clock });

      c.register(instance(roles)).as(RoleStore);
      c.register(instance(assignments)).as(AssignmentStore);
      c.register(instance(assignments)).as(AdminAssignmentStore);
      c.register(instance(links)).as(LinkStore);
      c.register(instance(links)).as(AdminLinkStore);
      c.register(instance(rules)).as(RuleStore);
      c.register(instance(rules)).as(AdminRuleStore);
      c.register(instance(model)).as(AuthorizationModel);
      c.register(instance(new RbacContributor(model))).as(AuthzContributor);

      if (admin) {
        c.register(instance(new RecordingAuthzSink())).as(AuthzEventSink);
        c.register(UsersAcceptanceBackend).as(AuthzAdminBackend);
        // authz-rbac's shipped guard (its config/admin.ts), with the world's config.admin over it.
        const world = (host.world.config?.admin ?? {}) as { guard?: object };
        host.setConfig(['authz', 'admin'], {
          ...world,
          guard: { service: 'DefaultAdminGuard', privilegedPermission: 'users:update', protectSystemRole: true, preventEscalation: true, preventSelfLockout: true, preventLastPrivilegedRemoval: true, ...(world.guard ?? {}) },
          backend: 'UsersAcceptanceBackend',
        });
      }
    },
    extend: admin
      ? async (host, session) => ({
          admin: (session.authz as unknown as AuthzService).admin(),
          lane: { adminEvents: (await host.container.resolve(AuthzEventSink)) as RecordingAuthzSink },
        })
      : undefined,
  });
}

describe('plan C1 acceptance', function () {
  this.timeout(60000);

  describe('B10, B27: the parts that name lane C1, through a real host with users roles', () => {
    runBehaviour(['B10.rbac'], () => usersRbacHarness(false), { strict: true });
    // B12.write stays off after RFC C1-1 (applied in G2): the guard now covers glob grants against the registry, but a
    // glob that matches no registered permission refuses. admin.users' 'user.metadata:*' matches none in this world
    // (no package registers a user.metadata permission yet), so the world's superuser may not grant admin. Run
    // B12.write here once C2 registers the user.metadata permissions and the world's superuser holds them.
    runBehaviour(['B27.events'], () => usersRbacHarness(true), { strict: true });
  });

  describe("users' own write path emits RoleAssigned and RoleRevoked through AuthzAdmin (B12, B27)", () => {
    const sink = new RecordingAuthzSink();
    let sinkRegistered = false;

    before(() => {
      registerUsersTestHost();
      // Registered for the rest of the process (DI has no clean undo); it only records.
      if (!sinkRegistered) {
        sinkRegistered = true;
        DI.register(instance(sink)).as(AuthzEventSink);
      }
    });

    beforeEach(async () => {
      sink.events.length = 0;
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
      await bootUsersDb();
    });

    afterEach(() => {
      sinon.restore();
      DI.clearCache();
    });

    const roleEvents = () =>
      sink.events
        .filter((e) => e.type === 'RoleAssigned' || e.type === 'RoleRevoked')
        .map((e) => {
          const { subject, role, scope } = e.data as { subject: IdentityRef; role: string; scope: unknown };
          return { type: e.type, actor: e.actor?.type, subject, role, scope };
        });

    it('create() assigns its roles as SYSTEM: RoleAssigned at GLOBAL', async () => {
      const { User: u } = await create({ Email: 'b27-create@spinajs.pl', Login: 'b27-create', Password: 'passw0rd123' }, ['user']);

      expect(roleEvents()).to.deep.eq([{ type: 'RoleAssigned', actor: SYSTEM.type, subject: { type: 'user', id: u.Uuid }, role: 'user', scope: GLOBAL }]);
    });

    it('grant and revoke emit RoleAssigned and RoleRevoked with the actor', async () => {
      await grant('test@spinajs.pl', 'editor');
      await revoke('test@spinajs.pl', 'editor');

      expect(roleEvents().map((e) => [e.type, e.actor, e.role, e.subject.id])).to.deep.eq([
        ['RoleAssigned', SYSTEM.type, 'editor', TEST_USER_UUID],
        ['RoleRevoked', SYSTEM.type, 'editor', TEST_USER_UUID],
      ]);
    });
  });

  describe('A08 (lifecycle part), A12 (identity and flow parts) with users stores and lifecycle actions', () => {
    let issuer: SessionIssuer;

    class RecordingMailer extends PasswordMailer {
      public readonly mails: PasswordMail[] = [];
      public async send(mail: PasswordMail): Promise<void> {
        this.mails.push(mail);
      }
    }

    before(async () => {
      registerUsersTestHost();
      // users revokes through the SessionIssuer DI resolves: the kit's sessions port must be that instance.
      registerRecordingSessionIssuer();
      sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
      await bootUsersDb();
      issuer = (await DI.resolve(SessionIssuer)) as SessionIssuer;
    });

    after(() => {
      sinon.restore();
      DI.clearCache();
    });

    async function harness(ctx: HarnessContext): Promise<Harness> {
      const unsupported = Object.keys(ctx.config).filter((k) => k !== 'authn' || Object.keys(ctx.config.authn ?? {}).some((a) => a !== 'throttle'));
      if (unsupported.length > 0) {
        throw new UnsupportedConfig(unsupported);
      }

      const rows: number[] = [];
      const identities = new UserIdentityStore();
      const passwords = new UserPasswordStore();
      const hasher = new Argon2PasswordHasher({});
      await hasher.resolve();
      const throttle = new FakeBackoffThrottle(throttleParams(ctx.config));
      const events = new RecordingEventSink();
      const sinks = [await DI.resolve(UserAccountSink), await DI.resolve(QueueAuthnEventSink), events];
      const strategy = new LocalPasswordStrategy({ identities, passwords, hasher });
      await strategy.resolve();
      const password = new LocalPasswordService({ identities, passwords, sessions: issuer, throttle, tokens: null, secrets: new MemorySecretStore(), mailer: new RecordingMailer(), sinks, hasher, policy: new LocalPasswordPolicy({}) });
      const service = new FakeAuthnService({
        strategies: [strategy],
        throttle,
        identities,
        links: new MemoryIdentityLinkStore(),
        linking: { jit: false, byVerifiedEmail: false },
        policy: new EnrolledMfaPolicy([]),
        steps: [],
        sessions: issuer,
        sinks,
        principals: new RecordingPrincipalFactory(),
      });
      const metadataKeys = async (id: IdentityRef) => {
        const u = await storedUser(id.id);
        const found = (await User.query().Driver.select().from('users_metadata').columns(['Key']).where('user_id', u.Id)) as { Key: string }[];
        return found.map((r) => r.Key);
      };
      const notC1 = () => Promise.reject(new Error('A12/api (the metadata routes) is C2 and SEC1, not C1'));

      return {
        service,
        password,
        sessions: issuer,
        events,
        seed: {
          async user(spec) {
            const { user, ref } = await seedUser({ login: spec.login, email: spec.email ?? spec.login });
            rows.push(user.Id);
            if (spec.password !== undefined) {
              await passwords.set(ref, await hasher.hash(spec.password));
            }
            if (spec.status) {
              await setIdentityFlags(ref, spec.status);
            }
            return ref;
          },
          setStatus: setIdentityFlags,
        },
        lifecycle: {
          ban: async (id) => void (await ban(await storedUser(id.id))),
          deactivate: async (id) => void (await deactivate(await storedUser(id.id))),
        },
        identityMeta: {
          async set(id, key, value) {
            try {
              await setUserMeta(await storedUser(id.id), key, value);
              return { ok: true };
            } catch (err) {
              if (err instanceof InvalidArgument) {
                return { ok: false };
              }
              throw err;
            }
          },
        },
        metadata: {
          seedRaw: notC1,
          rawKeys: metadataKeys,
          rawValue: notC1,
          write: notC1,
          read: notC1,
          list: notC1,
          updateById: notC1,
          deleteById: notC1,
        },
        async dispose() {
          await password.drain();
          const driver = User.query().Driver;
          for (const id of rows) {
            await driver.del().from('users_metadata').where('user_id', id);
            await driver.del().from('users').where('Id', id);
          }
        },
      };
    }

    const C1_FACETS = ['A08/lifecycle', 'A12/identity', 'A12/flow'] as const;
    runAuthnBehaviour(['A08', 'A12'], harness, { facets: [...C1_FACETS], claim: [...C1_FACETS], timeoutMs: 60000 });
  });
});
