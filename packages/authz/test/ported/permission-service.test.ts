import * as chai from 'chai';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AccessDenied, AuthorizationModel, TRUE, UNATTENDED } from '@spinajs/authz';
import type { Decision, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { installHost, instance, registerInRoot, resetHost, rootService, setConfig, uninstallHost } from '../host/support.js';

const expect = chai.expect;

// Ported from users legacy-v2/permission-service.test.ts rows 1-3 and 11-16 (B09, B01, B02, B15, B07).
// PermissionService is replaced by authz().current/runAs/assert (design section 21).
const own: ResourceFilter = { op: 'relation', relation: 'owner' };
const widget: ResourceRef = { type: 'doc', id: '1' };

// admin: any; member: own on create and update; viewer: read only.
const ROLES: Record<string, Record<string, ResourceFilter>> = {
  admin: { 'doc:create': TRUE, 'doc:update': TRUE },
  member: { 'doc:create': own, 'doc:update': own },
  viewer: { 'doc:read': own },
};

class AppNoPermission extends Forbidden {}

/** What an app does with a denial: maps the reason code to its own error (design section 21). */
function errorFor(decision: Decision): Error {
  return new AppNoPermission(`app ${decision.permission} refusal (${decision.reason?.code})`);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('authz principal resolution and assert (ported PermissionService)', function () {
  this.timeout(10000);
  const store = () => DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;

  before(() => installHost());
  after(() => uninstallHost());

  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:create': {}, 'doc:update': {}, 'doc:read': {}, 'doc:delete': {} });
    registerInRoot(
      AuthorizationModel,
      instance(
        new StaticModel({
          name: 'roles',
          votes: (req) => {
            const grant = ROLES[req.principal.id]?.[req.permission];
            return grant ? { permitWhen: grant } : {};
          },
        }),
      ),
    );
  });

  describe('acting principal (B09)', () => {
    it('an explicit principal wins over the ambient one', async () => {
      const svc = await rootService();
      const ambient = userPrincipal('member');
      const out = await svc.runAs(ambient, 'ambient', async () => {
        // an explicit principal is what check() judges, whatever current() is
        const asAdmin = await svc.check({ principal: userPrincipal('admin'), permission: 'doc:create', resource: widget });
        const asAmbient = await svc.check({ permission: 'doc:create', resource: widget } as never);
        return { asAdmin, asAmbient };
      });
      expect(out.asAdmin.principal).to.deep.equal({ type: 'user', id: 'admin' });
      expect(out.asAdmin.residual).to.deep.equal(TRUE);
      expect(out.asAmbient.principal).to.deep.equal({ type: 'user', id: 'member' });
      expect(out.asAmbient.residual).to.deep.equal(own);
    });

    it('current() falls back to the AsyncLocalStorage principal', async () => {
      const svc = await rootService();
      const ambient = userPrincipal('member');
      await store().run({ Principal: ambient }, async () => {
        expect(svc.current()).to.equal(ambient);
      });
    });

    it('with no principal anywhere it is UNATTENDED and every check denies', async () => {
      const svc = await rootService();
      expect(svc.current()).to.equal(UNATTENDED);

      const decision = await svc.check({ permission: 'doc:create', resource: widget } as never);
      expect(decision.allowed).to.equal(false);
      expect(decision.reason?.code).to.equal('unattended');

      const error = await rejection(svc.assert(svc.current(), 'doc:create', widget));
      expect(error).to.have.property('name', 'AccessDenied');
      expect((error as AccessDenied).decision.reason?.code).to.equal('unattended');
    });
  });

  describe('assert (B01, B02, B15)', () => {
    it('answers the principal and the residual on a grant', async () => {
      const svc = await rootService();

      const conditional = await svc.assert(userPrincipal('member'), 'doc:create', widget);
      expect(conditional.principal).to.deep.equal({ type: 'user', id: 'member' });
      expect(conditional.allowed).to.equal(true);
      expect(conditional.residual).to.deep.equal(own);

      const unconditional = await svc.assert(userPrincipal('admin'), 'doc:create', widget);
      expect(unconditional.residual).to.deep.equal(TRUE);
    });

    it('throws AccessDenied naming permission, resource and reason when there is no grant', async () => {
      const svc = await rootService();
      const error = (await rejection(svc.assert(userPrincipal('viewer'), 'doc:delete', widget))) as AccessDenied;

      expect(error).to.have.property('name', 'AccessDenied');
      expect(error).to.be.instanceOf(Forbidden);
      expect(error.message).to.match(/doc:delete.*doc/);
      expect(error.decision.permission).to.equal('doc:delete');
      expect(error.decision.resource).to.deep.equal(widget);
      expect(error.decision.reason?.code).to.equal('no_access');
    });

    it('an unregistered permission is a programming error, never a denial (B02)', async () => {
      const svc = await rootService();
      const error = await rejection(svc.assert(userPrincipal('admin'), 'doc:frob', widget));
      expect(error).to.not.be.instanceOf(AccessDenied);
      expect((error as Error).name).to.equal('UnknownPermission');
    });

    it('an app error replaces the default one through errorFor(decision)', async () => {
      const svc = await rootService();
      let error: unknown;
      try {
        await svc.assert(userPrincipal('viewer'), 'doc:delete', widget);
      } catch (e) {
        error = errorFor((e as AccessDenied).decision);
      }
      expect(error).to.be.instanceOf(AppNoPermission);
      expect(error).to.not.be.instanceOf(AccessDenied);
      expect((error as Error).message).to.equal('app doc:delete refusal (no_access)');
    });
  });

  describe('runAs (B09, B07)', () => {
    it('a different principal replaces the ambient one; the ceiling is not carried over; other store keys stay', async () => {
      const svc = await rootService();
      const ambient: Principal = userPrincipal('member', { ceiling: { roles: ['member'] } });
      await store().run({ Principal: ambient, Session: { fake: true } }, async () => {
        await svc.runAs(userPrincipal('admin'), 'impersonation', async () => {
          const inner = store().getStore()!;
          expect((inner.Principal as Principal).id).to.equal('admin');
          expect((inner.Principal as Principal).ceiling).to.equal(undefined);
          expect(svc.current().ceiling).to.equal(undefined);
          expect(inner.Session).to.deep.equal({ fake: true });
        });
        expect(svc.current()).to.equal(ambient);
      });
    });

    it('running as the ambient principal keeps the principal, its ceiling and the other keys', async () => {
      const svc = await rootService();
      const ambient: Principal = userPrincipal('member', { ceiling: { roles: ['member'] } });
      await store().run({ Principal: ambient, Session: { fake: true } }, async () => {
        await svc.runAs(ambient, 'same', async () => {
          const inner = store().getStore()!;
          expect(inner.Principal).to.equal(ambient);
          expect(svc.current().ceiling).to.deep.equal({ roles: ['member'] });
          expect(inner.Session).to.deep.equal({ fake: true });
        });
      });
    });

    it('runs outside any ambient context too, and answers the callback result', async () => {
      const svc = await rootService();
      expect(store().getStore()).to.equal(undefined);
      expect(await svc.runAs(userPrincipal('admin'), 'job', async () => 42)).to.equal(42);
    });
  });
});
