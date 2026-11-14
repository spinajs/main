import { expect } from 'chai';
import type { AuthzSection, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';
import { combineScopes } from '../../src/extractors/authz.js';

const access = (...permissions: string[]) => ({ type: 'AccessPolicy', options: permissions });
const admin = { type: 'AdminPolicy', options: [] };

describe('authz section', () => {
  let fragment: ManifestFragment;
  let authz: AuthzSection;
  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-pkg/tsconfig.json', packageRoot: 'test/fixtures/authz-pkg' });
    authz = fragment.authz!;
  });

  const entry = (id: string) => authz.entryPoints.find((e) => e.id === id);

  it('types a model by the nearest registered class of its chain, or by a literal registerAccessResource call', () => {
    expect(fragment.models.map((m) => [m.className, m.accessResource])).to.deep.equal([
      ['Note', 'doc'],
      ['Plain', 'plain'],
      ['Tag', undefined],
    ]);
  });

  it('lists each resource with the relation columns of its decorators and registration options', () => {
    expect(authz.resources.map((r) => [r.type, r.model, r.relations])).to.deep.equal([
      ['doc', 'authz-pkg:Note', [
        { name: 'editor', kind: 'relation', column: 'EditorId' },
        { name: 'self', kind: 'self', column: 'SelfId' },
        { name: 'parent', kind: 'parent', column: 'FolderId', target: 'folder' },
        { name: 'owner', kind: 'owner', column: 'OwnerId' },
      ]],
      ['plain', 'authz-pkg:Plain', [
        { name: 'parent', kind: 'parent', column: 'FolderId', target: 'folder' },
        { name: 'owner', kind: 'owner', column: 'OwnerColumn' },
        { name: 'reviewer', kind: 'relation', column: 'ReviewerId' },
      ]],
      ['job', '@spinajs/queue:JobModel', []],
    ]);
  });

  it('catalogues the permissions the ORM adapter registers for every resource type', () => {
    expect(authz.permissions.filter((p) => p.name.startsWith('doc:'))).to.deep.equal(['read', 'create', 'update', 'delete'].map((a) => ({ name: `doc:${a}`, declaredIn: 'model' })));
    expect(authz.permissions).to.have.length(12);
  });

  it('combines the class and handler scopes of a route', () => {
    expect(entry('GET /docs/:id')).to.deep.include({ kind: 'route', access: [[access('doc:read')]] });
    expect(entry('POST /docs/create')?.access).to.deep.equal([[access('doc:read'), access('doc:create')]]);
  });

  it('captures class-level and event @SocketAccess and @SocketPolicy', () => {
    const docs = fragment.socketControllers.find((c) => c.className === 'DocsSocket')!;
    expect(docs).to.deep.include({ access: ['doc:read'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(docs.events.find((e) => e.name === 'seen')).to.deep.include({ access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['route'] }]] });
    const open = fragment.socketControllers.find((c) => c.className === 'OpenSocket')!;
    expect(open).to.not.have.any.keys('access', 'policies');
    expect(open.events[0]).to.not.have.any.keys('access', 'policies');
  });

  it('lists socket commands and events with the class and handler scopes combined', () => {
    expect(entry('docs.edit')).to.deep.include({ kind: 'socket-command', access: [[admin, access('doc:update')], [access('doc:read'), access('doc:update')]] });
    expect(entry('docs.ping')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    expect(entry('docs.seen')).to.deep.include({ kind: 'socket-event', access: [[admin, access('doc:read')], [access('doc:read'), access('doc:read')]] });
    expect(entry('hello')).to.deep.include({ kind: 'socket-event', access: [] });
  });

  it('lists queue handlers, schedules and CLI commands with their @SystemTask reason', () => {
    expect(entry('job:Reindex')).to.deep.include({ kind: 'queue-handler', access: [[access('doc:update')]] });
    expect(entry('job:Reindex')).to.not.have.property('system');
    expect(entry('job:Sweep')).to.deep.include({ access: [], system: 'purges expired drafts of every tenant' });
    expect(entry('event:DocSeen')).to.deep.include({ kind: 'queue-handler', access: [] });
    expect(authz.entryPoints.filter((e) => e.kind === 'queue-handler').map((e) => e.id)).to.deep.equal(['job:Reindex', 'job:Sweep', 'event:DocSeen', 'event:DocPublished']);
    expect(entry('nightly')).to.deep.include({ kind: 'schedule', system: 'nightly reindex' });
    expect(entry('docs:sync')).to.deep.include({ kind: 'cli', access: [] });
  });

  it('records spinajs-authz-ignore comments and leaves the findings to the flow pass', () => {
    expect(authz.ignores).to.deep.equal([{ code: 'AUTHZ001', reason: 'the export reads every document on purpose', source: { file: 'src/controller.ts', line: 10, col: 3, package: 'authz-pkg' } }]);
    expect(authz.findings).to.deep.equal([]);
    expect(authz).to.not.have.property('ir');
  });

  it('gives a socket subclass the class guards of its base, its own @SocketAccess replacing the inherited one', () => {
    const child = fragment.socketControllers.find((c) => c.className === 'ChildSocket')!;
    expect(child).to.deep.include({ access: ['doc:read'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(entry('child.own')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    expect(entry('child.base')?.access).to.deep.equal([[admin], [access('doc:read')]]);
    const narrow = fragment.socketControllers.find((c) => c.className === 'NarrowSocket')!;
    expect(narrow).to.deep.include({ access: ['doc:update'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(entry('narrow.base')?.access).to.deep.equal([[admin], [access('doc:update')]]);
  });

  it('records the literal resource extractor and anonymous access with the permissions', () => {
    const share = { type: 'AccessPolicy', options: ['doc:share', { allowAnonymous: true, resource: { type: 'doc' } }] };
    expect(entry('narrow.share')?.access).to.deep.equal([[admin, share], [access('doc:update'), share]]);
    expect(entry('GET /open/note/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['doc:read', { allowAnonymous: true, resource: { type: 'doc' } }] }]]);
    expect(entry('GET /open/model/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['doc:update', { resource: { model: 'authz-pkg:Note' } }] }]]);
    expect(entry('GET /open/typed/:id')?.access).to.deep.equal([[{ type: 'AccessPolicy', options: ['report:run', { resource: { type: 'report' } }] }]]);
  });

  it('declares @Public and a bare @AllowAnonymous as the access of an otherwise unguarded route', () => {
    expect(entry('GET /open/health')?.access).to.deep.equal([[{ type: 'Public', options: ['load balancer probe'] }]]);
    expect(entry('GET /open/ping')?.access).to.deep.equal([[{ type: 'AllowAnonymous', options: [] }]]);
  });

  it('takes the @SystemTask of an event class for its consume() handler', () => {
    expect(entry('event:DocPublished')).to.deep.include({ kind: 'queue-handler', access: [], system: 'mirrors every published document to the search index' });
    expect(entry('event:DocSeen')).to.not.have.property('system');
  });

  it('crosses OR-of-AND scopes, an empty scope requiring nothing', () => {
    expect(combineScopes([[admin]], [])).to.deep.equal([[admin]]);
    expect(combineScopes([], [[admin]])).to.deep.equal([[admin]]);
    expect(combineScopes([[admin], [access('a:b')]], [[access('c:d')]])).to.deep.equal([[admin, access('c:d')], [access('a:b'), access('c:d')]]);
  });
});
