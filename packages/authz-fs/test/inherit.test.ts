import * as chai from 'chai';
import 'mocha';

import { FALSE, GLOBAL, PermissionRegistryImpl, TRUE } from '@spinajs/authz';
import type { Decision, DecisionRequest, EvaluationContext, PermissionDef, ResourceRef, Vote } from '@spinajs/authz';
import { agentPrincipal, userPrincipal } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { FS_PERMISSIONS, FsInheritModel, FsPathResolver } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

const task = (id: string): ResourceRef => ({ type: 'task', id });
const project = (id: string): ResourceRef => ({ type: 'project', id });
const file = (id: string): ResourceRef => ({ type: 'file', id });

/** tasks/<id>/… has the task and then the project p-<id> as parents; anything else has none. */
class TaskProjectResolver extends FsPathResolver {
  readonly fs = /^(uploads|archive)$/;
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    const m = /^tasks\/([^/]+)\//.exec(path);
    return m ? [task(m[1]), project(`p-${m[1]}`)] : null;
  }
}

const INHERIT = { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' };

const FS = {
  uploads: { mode: 'enforce', domain: 'fs', inherit: INHERIT },
  archive: { mode: 'audit', domain: 'fs', inherit: { 'fs:list': 'browse' } },
  rooted: { mode: 'enforce', domain: 'other', inherit: INHERIT },
  sleeping: { mode: 'off', domain: 'fs', inherit: { 'fs:share': 'read' } },
};

function registry(): PermissionRegistryImpl {
  const r = new PermissionRegistryImpl();
  r.register(
    FS_PERMISSIONS.map((p) => ({ ...p })),
    'adapter:fs',
  );
  r.register(
    [
      { name: 'task:read', types: ['task'] },
      { name: 'task:update', types: ['task'] },
      { name: 'project:read', types: ['project'] },
      { name: 'project:update', types: ['project'] },
    ],
    'config',
  );
  r.freeze();
  return r;
}

const allowed = (req: Omit<DecisionRequest, 'explain'>, extra: Partial<Decision> = {}): Decision => ({ allowed: true, permission: req.permission, resource: req.resource, principal: { type: req.principal.type, id: req.principal.id }, residual: TRUE, fields: { read: [], write: [] }, roles: {}, domain: 'fs', ...extra });
const denied = (req: Omit<DecisionRequest, 'explain'>): Decision => ({ ...allowed(req), allowed: false, residual: FALSE });

type Check = (req: Omit<DecisionRequest, 'explain'>) => Promise<Decision>;

function context(reg: PermissionRegistryImpl, check: Check): EvaluationContext & { readonly checks: Omit<DecisionRequest, 'explain'>[] } {
  const checks: Omit<DecisionRequest, 'explain'>[] = [];
  return {
    domain: 'fs',
    now: new Date('2026-10-04T10:00:00Z'),
    permissions: reg,
    ancestors: async () => null,
    attributes: async () => null,
    conditions: undefined as unknown as EvaluationContext['conditions'],
    relation: () => undefined,
    check: (req) => {
      checks.push(req);
      return check(req);
    },
    cache: new Map(),
    trace: () => undefined,
    checks,
  };
}

const alice = userPrincipal('alice');

describe('authz-fs FsInheritModel (fs-inherit)', () => {
  let child: IContainer;
  let reg: PermissionRegistryImpl;
  let model: FsInheritModel;

  const def = (name: string): PermissionDef => reg.require(name);
  const req = (permission: string, resource: ResourceRef, extra: Partial<DecisionRequest> = {}): DecisionRequest => ({ principal: alice, permission, resource, env: { now: new Date() }, ...extra });
  const permits = (v: Vote): boolean => v.permitWhen.op === 'true' && v.error === undefined;
  const abstains = (v: Vote): boolean => v.permitWhen.op === 'false' && v.denyWhen.op === 'false' && v.error === undefined;

  beforeEach(async () => {
    child = await configuredChild(FS);
    child.register(TaskProjectResolver).as(FsPathResolver);
    reg = registry();
    model = new FsInheritModel('fs', child);
    model.init({ permissions: reg });
  });

  afterEach(async () => {
    await child.dispose();
  });

  it('declares the capabilities of design §13', () => {
    expect(model.name).to.equal('fs-inherit');
    expect(model.capabilities).to.deep.equal({ effects: ['permit'], residuals: [], sync: 'never', fields: false, needsSubject: false, resourceTypes: ['file', 'dir'] });
  });

  it('applies to the fs permissions a filesystem of its domain maps, or one they imply, on files and directories only', () => {
    for (const type of ['file', 'dir']) {
      for (const name of ['fs:read', 'fs:write', 'fs:delete', 'fs:list', 'fs:stat']) expect(model.applies(def(name), type), `${name} ${type}`).to.equal(true);
      // fs:share is mapped only on a filesystem that is off.
      expect(model.applies(def('fs:share'), type)).to.equal(false);
    }
    expect(model.applies(def('fs:read'), 'fs')).to.equal(false);
    expect(model.applies(def('task:read'), 'task')).to.equal(false);

    const other = new FsInheritModel('elsewhere', child);
    other.init({ permissions: reg });
    expect(other.applies(def('fs:read'), 'file')).to.equal(false);
  });

  it('permits when the nearest parent allows the mapped permission, checked as the request principal with its actor and env', async () => {
    const ctx = context(reg, async (r) => (r.permission === 'task:read' ? allowed(r) : denied(r)));
    const agent = agentPrincipal('bot', alice);
    const env = { now: new Date(), ip: '10.0.0.1' };
    const vote = await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf'), { actor: agent, env }), ctx);
    expect(permits(vote)).to.equal(true);
    expect(vote.model).to.equal('fs-inherit');
    expect(ctx.checks).to.deep.equal([{ principal: alice, actor: agent, env, permission: 'task:read', resource: task('42') }]);
  });

  it('asks the parents nearest first and permits on the first that allows', async () => {
    const ctx = context(reg, async (r) => (r.resource.type === 'project' ? allowed(r) : denied(r)));
    const vote = await model.evaluate(req('fs:write', file('uploads:tasks/42/new.txt')), ctx);
    expect(permits(vote)).to.equal(true);
    expect(ctx.checks.map((c) => `${c.permission} ${c.resource.type}:${c.resource.id}`)).to.deep.equal(['task:update task:42', 'project:update project:p-42']);
  });

  it('maps a permission through the ones that imply it: fs:stat follows fs:read', async () => {
    const ctx = context(reg, async (r) => allowed(r));
    expect(permits(await model.evaluate(req('fs:stat', file('uploads:tasks/42/a.pdf')), ctx))).to.equal(true);
    expect(ctx.checks.map((c) => c.permission)).to.deep.equal(['task:read']);
  });

  it('carries the earliest expiry of the parent decision', async () => {
    const until = new Date('2026-10-04T11:00:00Z');
    const ctx = context(reg, async (r) => allowed(r, { validUntil: until }));
    const vote = await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf')), ctx);
    expect(vote.validUntil).to.deep.equal(until);
  });

  it('abstains without a permit: denied or conditional parents, no parents, unmapped permissions, type-level requests, the root, other filesystems', async () => {
    const conditional = context(reg, async (r) => allowed(r, { residual: { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' } }));
    expect(abstains(await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf')), conditional))).to.equal(true);
    expect(conditional.checks).to.have.length(2);

    const none = context(reg, async (r) => denied(r));
    expect(abstains(await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf')), none))).to.equal(true);

    const any = context(reg, async (r) => allowed(r));
    for (const [permission, resource] of [
      ['fs:read', file('uploads:public/a.png')],
      ['fs:share', file('uploads:tasks/42/a.pdf')],
      ['fs:read', { type: 'file' }],
      ['fs:read', { type: 'fs', id: 'uploads' }],
      ['fs:read', file('rooted:tasks/42/a.pdf')],
      ['fs:read', file('sleeping:tasks/42/a.pdf')],
      ['fs:read', file('uploads:../x')],
    ] as const) {
      expect(abstains(await model.evaluate(req(permission, resource), any)), `${permission} ${resource.type}:${resource.id}`).to.equal(true);
    }
    expect(any.checks).to.deep.equal([]);
  });

  it('is indeterminate when a parent permission is not registered on the parent type, or a parent check throws (B04)', async () => {
    const unknown = context(reg, async (r) => denied(r));
    const vote = await model.evaluate(req('fs:list', file('archive:tasks/42/x')), unknown);
    expect(vote.error).to.include('authz.fs.archive.inherit').and.include('task:browse');
    expect(vote.permitWhen).to.deep.equal(FALSE);
    expect(vote.cacheable).to.equal(false);

    const throwing = context(reg, async (r) => {
      if (r.resource.type === 'task') throw new Error('task store down');
      return denied(r);
    });
    const failed = await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf')), throwing);
    expect(failed.error).to.include('task store down');
  });

  it('still permits through a parent that allows when another parent could not be checked', async () => {
    const ctx = context(reg, async (r) => {
      if (r.resource.type === 'task') throw new Error('task store down');
      return allowed(r);
    });
    expect(permits(await model.evaluate(req('fs:read', file('uploads:tasks/42/a.pdf')), ctx))).to.equal(true);
  });

  it('summarises every permission it may grant as conditional (E1: covers then needs the holder to hold it unconditionally)', async () => {
    const ctx = context(reg, async (r) => allowed(r));
    const names = (s: { permissions: readonly { name: string; conditional: boolean }[] }) => s.permissions.map((p) => `${p.name}${p.conditional ? '?' : ''}`);
    expect(names(await model.summarize(alice, GLOBAL, ctx))).to.deep.equal(['fs:delete?', 'fs:list?', 'fs:read?', 'fs:stat?', 'fs:write?']);
    expect(names(await model.summarize(alice, file('archive:tasks/1/x'), ctx))).to.deep.equal(['fs:list?']);
    expect(names(await model.summarize(alice, { type: 'dir' }, ctx))).to.deep.equal(['fs:delete?', 'fs:list?', 'fs:read?', 'fs:stat?', 'fs:write?']);
    expect(names(await model.summarize(alice, file('rooted:tasks/1/x'), ctx))).to.deep.equal([]);
    expect(names(await model.summarize(alice, task('42'), ctx))).to.deep.equal([]);
    expect((await model.summarize(alice, GLOBAL, ctx)).model).to.equal('fs-inherit');
    expect(ctx.checks).to.deep.equal([]);
  });
});
