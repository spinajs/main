import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzDomains, AuthzService as AuthzServiceToken, SYSTEM, UNATTENDED } from '@spinajs/authz';
import type { AuthorizationModel, AuthzService, Principal, RelationResolver } from '@spinajs/authz';
import { RbacService } from '@spinajs/authz-rbac';
import { testHost, userPrincipal } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { FileAclStore, FsAclRelation, FsResourceAdapter } from '../src/index.js';
import type { FsRefType } from '../src/index.js';
import { configuredChild } from './helpers.js';
import { ALICE, BOB, TEAM } from './support/acl-contract.js';
import { MemoryFileAclStore } from './support/memory-acl-store.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const file = (id: string) => ({ type: 'file', id });

describe('authz-fs FsAclRelation', () => {
  let child: IContainer;
  let acl: MemoryFileAclStore;
  let domainContainers: Map<string, IContainer>;
  /** The models each domain's AuthzService runs. */
  let domainModels: Map<string, AuthorizationModel[]>;
  const modelOf = (name: string) => ({ name }) as AuthorizationModel;

  beforeEach(async () => {
    child = await configuredChild({ uploads: { mode: 'enforce' }, files: { mode: 'enforce', domain: 'files' } });
    acl = new MemoryFileAclStore();
    child.register(testHost.instance<FileAclStore>(acl)).as(FileAclStore);
    domainContainers = new Map();
    domainModels = new Map();
    const domains = {
      container: (name: string) => {
        const found = domainContainers.get(name);
        if (!found) throw new AuthzConfigError(`Authz domain "${name}" does not exist`);
        return found;
      },
      service: async (name: string) => ({ models: () => domainModels.get(name) ?? [] }) as unknown as AuthzService,
    } as unknown as AuthzDomains;
    child.register(testHost.instance(domains)).as(AuthzDomains);
  });

  afterEach(async () => {
    await child.dispose();
  });

  const relation = (name = 'viewer', type: FsRefType = 'file') => new FsAclRelation(type, name, child);

  it('FsResourceAdapter serves one per fs type and authz.fsAcl relation, owner always among them', () => {
    const adapter = new FsResourceAdapter(child);
    const served = () => adapter.relations().map((r) => `${r.type}#${r.relation}`);
    expect(served()).to.deep.equal(['fs#owner', 'fs#editor', 'fs#viewer', 'dir#owner', 'dir#editor', 'dir#viewer', 'file#owner', 'file#editor', 'file#viewer']);
    (child.get(Configuration) as Configuration).set(['authz', 'fsAcl'], { relations: ['reviewer'] });
    expect(served()).to.deep.equal(['fs#owner', 'fs#reviewer', 'dir#owner', 'dir#reviewer', 'file#owner', 'file#reviewer']);
    for (const r of adapter.relations()) expect(r).to.be.instanceOf(FsAclRelation);
  });

  it('holds through a row at the path, a parent directory or the filesystem root (nearest-up, D7)', async () => {
    await acl.grant({ fs: 'uploads', path: 'docs', subject: ALICE, relation: 'viewer' });
    expect(await relation().holds(alice, file('uploads:docs/a.txt'))).to.equal(true);
    expect(await relation('viewer', 'dir').holds(alice, { type: 'dir', id: 'uploads:docs' })).to.equal(true);
    expect(await relation().holds(alice, file('uploads:docs2/a.txt'))).to.equal(false);
    expect(await relation().holds(alice, file('uploads:other.txt'))).to.equal(false);
    await acl.grant({ fs: 'uploads', path: '', subject: ALICE, relation: 'viewer' });
    expect(await relation().holds(alice, file('uploads:other.txt'))).to.equal(true);
    expect(await relation('viewer', 'fs').holds(alice, { type: 'fs', id: 'uploads' })).to.equal(true);
  });

  it('reads the store, never the subject; another relation, filesystem or principal does not hold', async () => {
    await acl.grant({ fs: 'uploads', path: 'a.txt', subject: BOB, relation: 'viewer' });
    const claimed = relation() as RelationResolver;
    expect(await claimed.holds(alice, file('uploads:a.txt'), { owner: ALICE, path: 'a.txt' })).to.equal(false);
    expect(await relation('editor').holds(userPrincipal('bob'), file('uploads:a.txt'))).to.equal(false);
    expect(await relation().holds(userPrincipal('bob'), file('archive:a.txt'))).to.equal(false);
    expect(await relation().holds(userPrincipal('bob'), file('uploads:a.txt'))).to.equal(true);
  });

  it('refuses refs of another type, foreign refs, and principals that own nothing', async () => {
    await acl.grant({ fs: 'uploads', path: '', subject: { type: 'user', id: '*' }, relation: 'viewer' });
    expect(await relation('viewer', 'file').holds(alice, { type: 'dir', id: 'uploads:a' })).to.equal(false);
    expect(await relation().holds(alice, { type: 'task', id: '1' })).to.equal(false);
    expect(await relation().holds(alice, file('uploads:a/../b'))).to.equal(false);
    for (const p of [SYSTEM, UNATTENDED, { ...userPrincipal('a1'), type: 'anonymous' }, { ...userPrincipal('l1'), type: 'link' }] as Principal[]) {
      expect(await relation().holds(p, file('uploads:a.txt')), p.type).to.equal(false);
    }
  });

  it('a row past its expiresAt does not hold', async () => {
    await acl.grant({ fs: 'uploads', path: 'a.txt', subject: ALICE, relation: 'viewer', expiresAt: new Date(Date.now() - 1000) });
    expect(await relation().holds(alice, file('uploads:a.txt'))).to.equal(false);
  });

  it('without an RbacService in the domain the subject keys are the principal and its type wildcard', async () => {
    await acl.grant({ fs: 'uploads', path: 'w.txt', subject: { type: 'user', id: '*' }, relation: 'viewer' });
    await acl.grant({ fs: 'uploads', path: 's.txt', subject: TEAM, relation: 'viewer' });
    expect(await relation().holds(alice, file('uploads:w.txt'))).to.equal(true);
    expect(await relation().holds(alice, file('uploads:s.txt'))).to.equal(false);
  });

  // RbacService.subjectKeysOf applies the role ceiling (plan D): under a ceiling a set row counts only through a
  // membership whose role passes ceiling.roles, and nested sets drop. The relation hands it the principal it got (the
  // narrowed delegate under 'inherit') unchanged, so that rule reaches the file ACL.
  it("asks the domain's RbacService for the subject keys of the principal it is given, at the domain time; a set row holds", async () => {
    const seen: [Principal, Date | undefined][] = [];
    const model = modelOf('rbac');
    const rbac = { model, subjectKeysOf: async (p: Principal, at?: Date) => (seen.push([p, at]), ['user:alice', 'team:t1#team.member']) } as unknown as RbacService;
    const files = child.child();
    files.register(testHost.instance(rbac)).as(RbacService);
    domainContainers.set('files', files);
    domainModels.set('files', [model]);
    await acl.grant({ fs: 'files', path: 'docs', subject: TEAM, relation: 'viewer' });

    const delegate = { ...alice, ceiling: { roles: ['team.member'] } } as Principal;
    expect(await relation().holds(delegate, file('files:docs/a.txt'))).to.equal(true);
    expect(seen).to.have.length(1);
    expect(seen[0][0]).to.equal(delegate);
    expect(seen[0][1]).to.be.instanceOf(Date);
  });

  it("finds a parent domain's RbacService, but not for a domain whose AuthzService does not run its model", async () => {
    let asked = 0;
    const model = modelOf('rbac');
    const rbac = { model, subjectKeysOf: async () => (asked++, ['user:alice', 'team:t1#team.member']) } as unknown as RbacService;
    const parent = child.child();
    parent.register(testHost.instance(rbac)).as(RbacService);
    domainContainers.set('files', parent.child());
    await acl.grant({ fs: 'files', path: 'docs', subject: TEAM, relation: 'viewer' });

    domainModels.set('files', [modelOf('abac')]);
    expect(await relation().holds(alice, file('files:docs/a.txt'))).to.equal(false);
    expect(asked).to.equal(0);

    domainModels.set('files', [modelOf('abac'), model]);
    expect(await relation().holds(alice, file('files:docs/a.txt'))).to.equal(true);
    expect(asked).to.equal(1);
  });

  it('in the root domain it uses the RbacService of the container when the container AuthzService runs its model', async () => {
    const model = modelOf('rbac');
    const rbac = { model, subjectKeysOf: async () => ['user:alice', 'team:t1#team.member'] } as unknown as RbacService;
    child.register(testHost.instance(rbac)).as(RbacService);
    const models: AuthorizationModel[] = [];
    child.register(testHost.instance({ models: () => models } as unknown as AuthzService)).as(AuthzServiceToken);
    await acl.grant({ fs: 'uploads', path: 'docs', subject: TEAM, relation: 'viewer' });
    expect(await relation().holds(alice, file('uploads:docs/a.txt'))).to.equal(false);
    models.push(model);
    expect(await relation().holds(alice, file('uploads:docs/a.txt'))).to.equal(true);
  });

  it('a path longer than the ACL column is covered by a parent row; without one it does not hold', async () => {
    const long = 'x'.repeat(600);
    await acl.grant({ fs: 'uploads', path: 'docs', subject: ALICE, relation: 'viewer' });
    expect(await relation().holds(alice, file(`uploads:docs/${long}`))).to.equal(true);
    expect(await relation().holds(alice, file(`uploads:other/${long}`))).to.equal(false);
  });
});
