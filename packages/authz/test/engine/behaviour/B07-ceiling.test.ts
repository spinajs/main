import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../../src/engine/authorizer.js';
import { FALSE, GLOBAL, TRUE, and } from '../../../src/index.js';
import type { Ceiling, Principal, ResourceFilter } from '../../../src/index.js';
import { FakeAdapter, FakeRow, RecordingAudit, StaticModel, deny, fakeClock, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
  { name: 'org:create', types: ['org'] },
]);
const team: ResourceFilter = { op: 'cmp', field: 'team', cmp: 'eq', value: 'red' };

const rows = [new FakeRow('doc', 'd1', {}, { type: 'org', id: 'o1' }), new FakeRow('doc', 'd2', {}, { type: 'org', id: 'o2' })];
const nodes = { 'org:o1': null, 'org:o2': null };

const setup = (models: StaticModel[], options: Partial<AuthorizerOptions> = {}) => {
  const clock = fakeClock();
  const audit = new RecordingAudit();
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [new FakeAdapter(['doc', 'org'], { rows, nodes })], clock: clock.clock, audit, ...options });
  return { a, clock, audit };
};
const capped = (ceiling: Ceiling, extra: Partial<Principal> = {}): Principal => principal('user', 'alice', { ceiling, ...extra });

describe('B07: a ceiling only narrows', () => {
  it('B07: a permission outside ceiling.permissions denies with ceiling (200), and the models still run', async () => {
    const m = new StaticModel('m', { vote: permit() });
    const { a } = setup([m]);
    const p = capped({ permissions: ['doc:read'] });
    expect((await a.check({ principal: p, permission: 'doc:read' })).allowed).to.equal(true);
    const d = await a.check({ principal: p, permission: 'doc:write' });
    expect(d.allowed).to.equal(false);
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
    expect(d.fields).to.deep.equal({ read: [], write: [] });
    expect(m.calls).to.have.length(2);
  });

  it('B07: ceiling.reason names the deny code; permission globs match without implies', async () => {
    const { a } = setup([new StaticModel('m', { vote: permit() })]);
    const p = capped({ permissions: ['org:*'], reason: 'out_of_scope' });
    expect((await a.check({ principal: p, permission: 'org:create' })).allowed).to.equal(true);
    expect((await a.check({ principal: p, permission: 'doc:read' })).reason).to.deep.equal({ code: 'out_of_scope', priority: 200 });
  });

  it('B07: a resource not under ceiling.resources denies; one under them passes', async () => {
    const { a } = setup([new StaticModel('m', { vote: permit() })]);
    const p = capped({ resources: [{ type: 'org', id: 'o1' }] });
    expect((await a.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } })).allowed).to.equal(true);
    const d = await a.check({ principal: p, permission: 'doc:read', resource: { type: 'doc', id: 'd2' } });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
  });

  it('B07: a type-level check AND-s the allow with under(resources); filter and filterNow agree', async () => {
    const { a } = setup([new StaticModel('m', { vote: permit(team) })]);
    const p = capped({ resources: [{ type: 'org', id: 'o1' }] });
    const expected = and(team, { op: 'under', scopes: [{ type: 'org', id: 'o1' }] });
    expect((await a.check({ principal: p, permission: 'doc:read' })).residual).to.deep.equal(expected);
    expect(await a.filter(p, 'doc:read', 'doc')).to.deep.equal(expected);
    expect(a.filterNow(p, 'doc:read', 'doc')).to.deep.equal(expected);
  });

  it('B07: a GLOBAL check under a resource-scoped ceiling is denied statically', async () => {
    const { a } = setup([new StaticModel('m', { vote: permit() })]);
    const d = await a.check({ principal: capped({ resources: [{ type: 'org', id: 'o1' }] }), permission: 'org:create', resource: GLOBAL });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
    const open = await a.check({ principal: capped({ resources: [GLOBAL] }), permission: 'org:create', resource: GLOBAL });
    expect(open.residual).to.equal(TRUE);
  });

  it('B07: now >= expiresAt denies; before it the decision is valid until expiresAt', async () => {
    const { a, clock } = setup([new StaticModel('m', { vote: permit(TRUE, { validUntil: new Date('2026-12-01T00:00:00Z') }) })]);
    const expiresAt = new Date(clock.now.getTime() + 60_000);
    const p = capped({ expiresAt });
    const ok = await a.check({ principal: p, permission: 'doc:read' });
    expect(ok.allowed).to.equal(true);
    expect(ok.validUntil?.toISOString()).to.equal(expiresAt.toISOString());
    clock.advance(60_000);
    const d = await a.check({ principal: p, permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
  });

  it('B07: a ceiling never adds access: a covering ceiling leaves a model denial in place', async () => {
    const { a } = setup([new StaticModel('m', { vote: { reason: { code: 'role_too_low' } } })]);
    const d = await a.check({ principal: capped({ permissions: ['*'], resources: [GLOBAL] }), permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'role_too_low', model: 'm' });
  });

  it('B07: a lower-priority model reason wins over the ceiling; a higher one loses to it', async () => {
    const abac = new StaticModel('abac', { vote: deny(TRUE, { denies: [{ when: TRUE, reason: { code: 'agents_disabled', priority: 100 } }] }) });
    const p = capped({ permissions: [], reason: 'out_of_scope' });
    expect((await setup([abac]).a.check({ principal: p, permission: 'doc:read' })).reason).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'abac' });
    const rbac = new StaticModel('rbac', { vote: { reason: { code: 'role_too_low' } } });
    expect((await setup([rbac]).a.check({ principal: p, permission: 'doc:read' })).reason).to.deep.equal({ code: 'out_of_scope', priority: 200 });
  });

  it('B07: a malformed ceiling denies with ceiling (fail closed)', async () => {
    const { a } = setup([new StaticModel('m', { vote: permit() })]);
    for (const ceiling of [{ permissions: 'doc:read' }, { resources: [{ id: 'x' }] }, { expiresAt: 'tomorrow' }, { reason: '' }, 5]) {
      const d = await a.check({ principal: capped(ceiling as never), permission: 'doc:read' });
      expect(d.allowed, JSON.stringify(ceiling)).to.equal(false);
      expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
    }
  });

  it('B07: the ceiling is read before the models run; a model moving expiresAt changes nothing', async () => {
    const m = new StaticModel('m', {
      vote: (req) => {
        req.principal.ceiling?.expiresAt?.setTime(Date.UTC(2100, 0, 1));
        return { model: 'm', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
      },
    });
    const { a, clock } = setup([m]);
    const d = await a.check({ principal: capped({ expiresAt: new Date(clock.now.getTime() - 1) }), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'ceiling', priority: 200 });
  });

  it('B07: a ceiling denial is audited with the request principal', async () => {
    const { a, audit } = setup([new StaticModel('m', { vote: permit() })]);
    await a.check({ principal: capped({ permissions: [] }), permission: 'doc:read' });
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'user', id: 'alice' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'ceiling' }]);
  });
});
