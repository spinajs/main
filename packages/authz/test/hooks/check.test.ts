import * as chai from 'chai';
import 'mocha';
import { ManualClock, RecordingAudit, userPrincipal } from '@spinajs/authz-testing';
import { ActionHook } from '@spinajs/hooks';
import type { AfterContext } from '@spinajs/hooks';
import { RecordingActionHook } from '@spinajs/hooks/testing';

import { AccessDenied, AuthzClock, DecisionAudit } from '@spinajs/authz';
import type { AuthzService, Decision, ResourceRef } from '@spinajs/authz';
import { PERMISSIONS, START, domains, grantsModel, installHost, instance, rejection, resetHost, setConfig, uninstallHost } from '../admin/support.js';
import { activateIn, childWith, violationPaths } from '../host/support.js';
import { RefuseWhen, registerHooks } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const p1: ResourceRef = { type: 'project', id: 'p1' };
const PERMISSION = 'app:grants.read';

async function checkDomain(hooks: readonly ActionHook<any>[], enabled?: boolean) {
  setConfig(['authz', 'domains', 'test'], { permissions: PERMISSIONS, cache: { maxEntries: 100, ttlSeconds: 60 } });
  if (enabled !== undefined) setConfig(['authz', 'hooks', 'check'], enabled);
  const ds = await domains();
  const c = ds.create('test', 'root');
  const model = grantsModel();
  activateIn(c, 'test', model);
  const audit = new RecordingAudit();
  c.register(instance(audit)).as(DecisionAudit);
  c.register(instance(new ManualClock(START))).as(AuthzClock);
  registerHooks(c, hooks);
  const service: AuthzService = await ds.service('test');
  return { service, model, audit };
}

describe('the authz.check hook', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  describe('configuration', () => {
    it('authz.hooks.check defaults to false', async () => {
      const { child, configuration } = await childWith({});
      try {
        expect(configuration.get<boolean>(['authz', 'hooks', 'check'])).to.equal(false);
      } finally {
        await child.dispose();
      }
    });

    it('refuses a misspelt key under authz.hooks', async () => {
      const paths = await violationPaths(childWith({ authz: { hooks: { chek: true } } }));
      expect(paths).to.have.length.greaterThan(0);
    });
  });

  describe('off (the default)', () => {
    it('does not call a hook registered on authz.check', async () => {
      const rec = new RecordingActionHook(['authz.check']);
      const refuse = new RefuseWhen(['authz.check'], 'blocked');
      const { service } = await checkDomain([rec, refuse]);
      expect((await service.check({ principal: alice, permission: PERMISSION, resource: p1 })).allowed).to.equal(true);
      expect(await service.can(alice, PERMISSION, p1)).to.equal(true);
      await service.assert(alice, PERMISSION, p1);
      expect(rec.calls).to.deep.equal([]);
    });

    it('does not call it with the switch set to false either', async () => {
      const rec = new RecordingActionHook(['authz.check']);
      const { service } = await checkDomain([rec], false);
      await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      expect(rec.calls).to.deep.equal([]);
    });
  });

  describe('on', () => {
    it('a refusal turns an allow into a deny with reason hook:<code>', async () => {
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service } = await checkDomain([refuse], true);
      const d = await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('hook:frozen');
      expect(d.permission).to.equal(PERMISSION);
      expect(d.resource).to.deep.equal(p1);
      expect(d.principal).to.deep.equal({ type: 'user', id: 'alice' });
      expect(await service.can(alice, PERMISSION, p1)).to.equal(false);
      const err = await rejection(service.assert(alice, PERMISSION, p1));
      expect(err).to.be.instanceOf(AccessDenied);
      expect((err as AccessDenied).decision.reason?.code).to.equal('hook:frozen');
    });

    it('audits the forced deny with reason hook:<code>', async () => {
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service, audit } = await checkDomain([refuse], true);
      await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      const denies = audit.entries.filter((e) => e.kind === 'deny');
      expect(denies).to.have.length(1);
      expect(denies[0].reason).to.equal('hook:frozen');
      expect(denies[0].permission).to.equal(PERMISSION);
    });

    it('does not audit the forced deny with audit.denials off', async () => {
      setConfig(['authz', 'audit', 'denials'], false);
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service, audit } = await checkDomain([refuse], true);
      await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      expect(audit.entries.filter((e) => e.kind === 'deny')).to.deep.equal([]);
    });

    it('keeps the trace of an explain request on the forced deny', async () => {
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service } = await checkDomain([refuse], true);
      const d = await service.check({ principal: alice, permission: PERMISSION, resource: p1, explain: true });
      expect(d.reason?.code).to.equal('hook:frozen');
      expect(d.trace).to.not.equal(undefined);
    });

    it('never stores the refusal: the next check without the refusing hook is an allow served from the cache', async () => {
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service, model } = await checkDomain([refuse], true);
      expect((await service.check({ principal: alice, permission: PERMISSION, resource: p1 })).allowed).to.equal(false);
      const evaluated = model.requests.length;
      refuse.enabled = false;
      const d = await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      expect(d.allowed).to.equal(true);
      expect(model.requests.length).to.equal(evaluated);
    });

    it('never turns a deny into an allow: the decision stays a deny whatever the hooks do', async () => {
      const rec = new RecordingActionHook(['authz.check']);
      const { service } = await checkDomain([rec], true);
      const d = await service.check({ principal: bob, permission: PERMISSION, resource: p1 });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('no_access');
      expect(rec.calls.map((c) => c.phase)).to.deep.equal(['before', 'after']);
    });

    it('a refusal of a decision that is already a deny keeps the engine reason', async () => {
      const refuse = new RefuseWhen(['authz.check'], 'frozen');
      const { service } = await checkDomain([refuse], true);
      const d = await service.check({ principal: bob, permission: PERMISSION, resource: p1 });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('no_access');
    });

    it('hands the hook the principal, the permission and the resource', async () => {
      const rec = new RecordingActionHook(['authz.check']);
      const { service } = await checkDomain([rec], true);
      await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      const before = rec.calls.find((c) => c.phase === 'before');
      expect(before?.input).to.deep.include({ permission: PERMISSION, resource: p1 });
      expect((before?.input as { principal: { id: string } }).principal.id).to.equal('alice');
    });

    it('after hooks see the Decision', async () => {
      const seen: Decision[] = [];
      class Observe extends ActionHook {
        readonly actions = ['authz.check'] as const;
        after(ctx: AfterContext<'authz.check'>): void {
          seen.push(ctx.output);
        }
      }
      const { service } = await checkDomain([new Observe()], true);
      const d = await service.check({ principal: alice, permission: PERMISSION, resource: p1 });
      expect(seen).to.have.length(1);
      expect(seen[0].allowed).to.equal(true);
      expect(seen[0]).to.equal(d);
    });
  });
});
