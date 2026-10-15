import 'mocha';
import { expect } from 'chai';

import { AuthzConfigError, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { E2E_DIALECTS, e2eHarness, withPostgres } from './support/stack.js';
import { MODELS, PERMISSIONS, ROLES, authzOf, open, stackWorld } from './support/world.js';

const { assignment, combine, role } = fixtureDsl;
const alice = userPrincipal('alice');

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

for (const kind of E2E_DIALECTS) {
  describe(`e2e guard and list-filterability (${kind})`, function () {
    this.timeout(120_000);
    const harness = e2eHarness(kind);
    let s: HarnessSession | undefined;

    before(async function () {
      await withPostgres(this, kind);
      await harness.beforeAll?.();
    });
    after(() => harness.afterAll?.());
    afterEach(async () => {
      await s?.dispose();
      s = undefined;
    });

    describe('runtime guard (env test)', () => {
      it('a select on an @AccessResource model without .accessible() throws AuthzConfigError', async () => {
        s = await open(harness, stackWorld([assignment('a1', alice, 'viewer')]), 'guard');
        const Task = harness.model('Task') as unknown as { query(): any };
        const e = await rejection(authzOf(s).runAs(alice, 'e2e', async () => Task.query()));
        expect(e).to.be.instanceOf(AuthzConfigError);
      });

      it('.unscoped(reason) and runAs(SYSTEM) pass; a model without @AccessResource is not guarded', async () => {
        s = await open(harness, stackWorld([assignment('a1', alice, 'viewer')], { lane: { orm: { models: [...MODELS, { name: 'Note', columns: ['text'], rows: [{ id: 'n1', text: 'x' }] }] } } }), 'guard-bypass');
        const Task = harness.model('Task') as unknown as { query(): any };
        const Note = harness.model('Note') as unknown as { query(): any };
        expect(await authzOf(s).runAs(alice, 'e2e', async () => (await Task.query().unscoped('report')).length)).to.equal(5);
        expect(await runWithPrincipal(SYSTEM, async () => (await Task.query()).length)).to.equal(5);
        expect(await authzOf(s).runAs(alice, 'e2e', async () => (await Note.query()).length)).to.equal(1);
      });
    });

    describe('boot rule 12', () => {
      const refused = async (world: World, title: string, ...fragments: string[]) => {
        // A world that boots after all keeps its session, so afterEach disposes it and the next case can open.
        const e = await rejection(open(harness, world, title).then((opened) => void (s = opened)));
        expect(e).to.be.instanceOf(AuthzConfigError);
        expect(e.message).to.match(/\[6\.5\/12\]/);
        for (const f of fragments) expect(e.message).to.contain(f);
      };

      it('refuses a list permission routed with permit-overrides', async () => {
        await refused({ ...stackWorld(), combine: combine('permit-overrides', 'rbac') }, 'permit-overrides', 'task:read');
      });

      it('refuses a list permission with an RBAC grant on a relation other than owner or self', async () => {
        await refused({ ...stackWorld(), rbac: { roles: [...ROLES, role('teamlead', [{ permission: 'task:read', relation: 'team' }])], assignments: [] }, relations: [{ type: 'task', relation: 'team', holds: () => false }] } as World, 'relation', 'task:read');
      });

      it('refuses a list permission an ABAC policy grants on resource.*', async () => {
        await refused(
          { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [{ id: 'by-title', effect: 'permit', permissions: ['task:read'], when: { attr: 'resource.title', eq: 'a' }, source: 'config' }] } },
          'abac-resource',
          'task:read',
          'by-title',
        );
      });

      it('refuses a list permission on a type with no @AccessResource model', async () => {
        await refused({ ...stackWorld(), permissions: [...PERMISSIONS, { name: 'note:read', list: true }] }, 'no-model', 'note:read');
      });
    });

    describe('AuthzAdmin', () => {
      it('refuses a stored policy that would make a list permission unlistable (not_list_filterable)', async () => {
        s = await open(harness, { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [] } }, 'admin-policy');
        const [r] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'policy.put', policy: { id: 'by-title', effect: 'permit', permissions: ['task:read'], when: { attr: 'resource.title', eq: 'a' } } }]);
        expect(r.ok).to.equal(false);
        expect(r.ok === false && r.error.code).to.equal('not_list_filterable');
      });

      it('accepts a policy that reads no row', async () => {
        s = await open(harness, { ...stackWorld(), combine: combine('deny-overrides', 'rbac', 'abac'), abac: { policies: [] } }, 'admin-policy-ok');
        const [r] = await authzOf(s).admin().execute(SYSTEM, [{ kind: 'policy.put', policy: { id: 'mfa', effect: 'deny', permissions: ['task:update'], when: { not: { attr: 'principal.authn.assurance', eq: 'aal2' } }, reason: 'mfa_required' } }]);
        expect(r.ok, JSON.stringify(r)).to.equal(true);
      });
    });
  });
}
