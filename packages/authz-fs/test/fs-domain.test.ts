import * as chai from 'chai';
import 'mocha';

import { AuthorizationModel, AuthzConfigError, AuthzDomains, FALSE, GLOBAL, TRUE } from '@spinajs/authz';
import type { AuthzService, DecisionRequest, ModelCapabilities, ModelSummary, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuthzFsDecorator, FsAuthzContributor, FsInheritModel, FsPathResolver, assertFsDomainConfig, ensureFsDomain, parseFsAccessConfig } from '../src/index.js';
import { installQuietLog } from './support/log.js';

const expect = chai.expect;

class TaskResolver extends FsPathResolver {
  readonly fs = 'uploads';
  async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
    const m = /^tasks\/([^/]+)\//.exec(path);
    return m ? [{ type: 'task', id: m[1] }] : null;
  }
}

/** Unconditional grants per principal id, on every resource; its summary lists them as such. */
class GrantModel extends AuthorizationModel {
  readonly name = 'grants';
  readonly capabilities: ModelCapabilities = { effects: ['permit'], residuals: [], sync: 'always', fields: false, needsSubject: false };

  constructor(private readonly grants: Readonly<Record<string, readonly string[]>>) {
    super();
  }

  init(): void {}

  applies(): boolean {
    return true;
  }

  evaluate(req: DecisionRequest): Vote {
    return { model: this.name, permitWhen: (this.grants[req.principal.id] ?? []).includes(req.permission) ? TRUE : FALSE, denyWhen: FALSE, cacheable: true };
  }

  async summarize(principal: Principal): Promise<ModelSummary> {
    return { model: this.name, permissions: (this.grants[principal.id] ?? []).map((name) => ({ name, conditional: false })) };
  }
}

const FS_ALL = ['fs:read', 'fs:stat', 'fs:list', 'fs:write', 'fs:delete', 'fs:share'];

const alice = userPrincipal('alice');
const carol = userPrincipal('carol');
const admin = userPrincipal('admin');

const failure = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a throw');
};

let seq = 0;

describe('authz-fs fs domain bootstrap (D11) and fs-inherit in the engine', function () {
  this.timeout(20000);

  let owns = false;
  let undoLog: () => void;
  let scope: IContainer;
  let domains: Awaited<ReturnType<typeof testHost.domains>>;
  let names: string[];
  const keys: string[][] = [];

  const set = (path: string[], value: unknown): void => {
    testHost.config().set(path, value);
    keys.push(path);
  };
  const fresh = (): string => {
    const name = `fsd-${++seq}`;
    names.push(name);
    return name;
  };
  const ownModels = (c: IContainer) => c.getRegisteredTypes(AuthorizationModel, false) ?? [];

  before(async () => {
    try {
      testHost.config();
    } catch {
      owns = true;
      await testHost.installHost();
    }
    undoLog = installQuietLog();
    domains = await testHost.domains();
  });

  after(async () => {
    undoLog();
    if (owns) await testHost.uninstallHost();
  });

  beforeEach(() => {
    names = [];
    scope = DI.child();
    scope.register(TaskResolver).as(FsPathResolver);
  });

  afterEach(async () => {
    for (const name of names.reverse()) if (domains.names().includes(name)) await domains.container(name).dispose();
    for (const path of keys.splice(0).reverse()) testHost.config().unset(path);
    await scope.dispose();
  });

  it('creates a missing domain once, under the parent authz.domains.<name>.parent names, with fs-inherit in it only', async () => {
    const parent = fresh();
    const name = fresh();
    domains.create(parent);
    set(['authz', 'domains', name, 'parent'], parent);
    set(['authz', 'fs'], { uploads: { mode: 'enforce', domain: name }, archive: { mode: 'audit', domain: name } });

    expect(scope.resolve(AuthzDomains)).to.equal(domains);
    const child = ensureFsDomain(name, scope)!;
    expect(domains.container(name)).to.equal(child);
    expect(domains.parentOf(name)).to.equal(parent);
    expect(ensureFsDomain(name, scope)).to.equal(child);
    expect(ownModels(child)).to.have.length(1);
    expect(ownModels(domains.container(parent))).to.have.length(0);

    const models = (await domains.service(name)).models();
    expect(models.map((m) => m.name)).to.include('fs-inherit');
    expect(models.find((m) => m.name === 'fs-inherit')).to.be.instanceOf(FsInheritModel);
    expect((await domains.service(parent)).models().map((m) => m.name)).to.not.include('fs-inherit');
    expect(ensureFsDomain('root', scope)).to.equal(undefined);
    expect(ownModels(DI.RootContainer).some((t) => t === FsInheritModel)).to.equal(false);
  });

  it('adds fs-inherit to a domain the app created only when one of its filesystems maps inherit, and not over its own', async () => {
    const plain = fresh();
    const mapped = fresh();
    const own = fresh();
    set(['authz', 'fs'], { a: { mode: 'enforce', domain: plain }, b: { mode: 'enforce', domain: mapped, inherit: { 'fs:read': 'read' } }, c: { mode: 'enforce', domain: own, inherit: { 'fs:read': 'read' } } });
    const plainC = domains.create(plain);
    const mappedC = domains.create(mapped);
    const ownC = domains.create(own);
    class AppInheritModel extends FsInheritModel {}
    ownC.register(AppInheritModel).as(AuthorizationModel);

    ensureFsDomain(plain, scope);
    ensureFsDomain(mapped, scope);
    ensureFsDomain(mapped, scope);
    ensureFsDomain(own, scope);
    expect(ownModels(plainC)).to.have.length(0);
    expect(ownModels(mappedC)).to.have.length(1);
    expect(ownModels(ownC)).to.deep.equal([AppInheritModel]);
  });

  it('refuses to add fs-inherit to a domain that already booted', async () => {
    const name = fresh();
    set(['authz', 'fs'], { b: { mode: 'enforce', domain: name, inherit: { 'fs:read': 'read' } } });
    domains.create(name);
    await domains.service(name);
    const error = failure(() => ensureFsDomain(name, scope));
    expect(error).to.be.instanceOf(AuthzConfigError);
    expect(error.message).to.include(name).and.include('booted');
  });

  it('refuses inherit on a filesystem checked in root, from the decorator and from every domain boot', () => {
    const config = parseFsAccessConfig('uploads', { mode: 'enforce', inherit: { 'fs:read': 'read' } });
    expect(failure(() => assertFsDomainConfig('uploads', config)).message).to.include('authz.fs.uploads.inherit');
    expect(() => assertFsDomainConfig('uploads', parseFsAccessConfig('uploads', { mode: 'off', inherit: { 'fs:read': 'read' } }))).to.not.throw();

    set(['authz', 'fs'], { uploads: { mode: 'enforce', inherit: { 'fs:read': 'read' } } });
    const decorator = new AuthzFsDecorator(scope);
    const raw = {} as never;
    expect(failure(() => decorator.decorate(raw, { name: 'uploads', service: 'fsNative' } as never))).to.be.instanceOf(AuthzConfigError);
    expect(failure(() => new FsAuthzContributor(scope).contribute('other'))).to.be.instanceOf(AuthzConfigError);
  });

  it('the decorator creates the domain before the guard asks for its service', () => {
    const name = fresh();
    set(['authz', 'fs'], { uploads: { mode: 'enforce', domain: name } });
    new AuthzFsDecorator(scope).decorate({} as never, { name: 'uploads', service: 'fsNative' } as never);
    expect(domains.names()).to.include(name);
    expect(ownModels(domains.container(name))).to.have.length(1);
  });

  it('gives a domain boot the inherit keys as permission refs, so a misspelt one fails it', () => {
    set(['authz', 'fs'], { uploads: { mode: 'enforce', domain: 'files', inherit: { 'fs:raed': 'read' } } });
    const refs = new FsAuthzContributor(scope).contribute('files').permissionRefs ?? [];
    expect(refs.filter((r) => r.source === 'authz.fs.uploads.inherit').map((r) => `${r.permission} ${r.type}`)).to.deep.equal(['fs:raed file', 'fs:raed dir']);
  });

  describe('in the engine', () => {
    let name: string;
    let svc: AuthzService;

    beforeEach(async () => {
      name = fresh();
      set(['authz', 'fs'], { uploads: { mode: 'enforce', domain: name, inherit: { 'fs:read': 'read', 'fs:write': 'update' } } });
      set(['authz', 'domains', name], {
        permissions: { 'task:read': {}, 'task:update': {} },
        combine: { default: { algorithm: 'deny-overrides', models: ['grants', 'fs-inherit'] } },
        cache: { maxEntries: 0 },
      });
      const child = ensureFsDomain(name, scope)!;
      child.register(testHost.instance(new GrantModel({ alice: ['task:read'], carol: ['task:read', 'task:update'], admin: ['task:read', 'task:update', ...FS_ALL] }))).as(AuthorizationModel);
      svc = await domains.service(name);
    });

    const file = (path: string): ResourceRef => ({ type: 'file', id: `uploads:${path}` });

    it('permits fs:read and fs:stat through the parent task, and nothing elsewhere', async () => {
      expect(await svc.can(alice, 'fs:read', file('tasks/42/a.pdf'))).to.equal(true);
      expect(await svc.can(alice, 'fs:stat', file('tasks/42/a.pdf'))).to.equal(true);
      expect(await svc.can(alice, 'fs:write', file('tasks/42/a.pdf'))).to.equal(false);
      expect(await svc.can(carol, 'fs:write', file('tasks/42/a.pdf'))).to.equal(true);
      expect(await svc.can(alice, 'fs:read', file('public/a.png'))).to.equal(false);
      expect(await svc.can(alice, 'fs:read', { type: 'file' })).to.equal(false);
    });

    it('lists the inherited permissions as conditional in a summary', async () => {
      const summary = await svc.summary(alice, GLOBAL);
      const entry = (n: string) => summary.permissions.find((p) => p.name === n);
      expect(entry('fs:read')?.conditional).to.equal(true);
      expect(entry('fs:stat')?.conditional).to.equal(true);
      expect(entry('task:read')?.conditional).to.equal(false);
      const model = summary.models.find((m) => m.model === 'fs-inherit');
      expect(model?.permissions.map((p) => p.name)).to.deep.equal(['fs:read', 'fs:stat', 'fs:write']);
    });

    it('makes covers fail closed: only a holder of the inherited permissions on every file covers the target', async () => {
      expect(await svc.covers(admin, alice)).to.equal(true);
      // carol holds more task permissions than alice, but not fs:read on every file.
      expect(await svc.covers(carol, alice)).to.equal(false);
    });
  });
});
