import { expect } from 'chai';
import type { AuthzSection, ManifestFragment } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';

const admin = { type: 'AdminPolicy', options: [] };

describe('authz section', () => {
  let fragment: ManifestFragment;
  let authz: AuthzSection;
  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-pkg/tsconfig.json', packageRoot: 'test/fixtures/authz-pkg' });
    authz = fragment.authz!;
  });

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

  it('captures class-level and event @SocketAccess and @SocketPolicy', () => {
    const docs = fragment.socketControllers.find((c) => c.className === 'DocsSocket')!;
    expect(docs).to.deep.include({ access: ['doc:read'], policies: [[admin], [{ type: 'AccessPolicy', options: ['class'] }]] });
    expect(docs.events.find((e) => e.name === 'seen')).to.deep.include({ access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['route'] }]] });
    const open = fragment.socketControllers.find((c) => c.className === 'OpenSocket')!;
    expect(open).to.not.have.any.keys('access', 'policies');
    expect(open.events[0]).to.not.have.any.keys('access', 'policies');
  });

  it('records spinajs-authz-ignore comments and leaves the findings to the flow pass', () => {
    expect(authz.ignores).to.deep.equal([{ code: 'AUTHZ001', reason: 'the export reads every document on purpose', source: { file: 'src/controller.ts', line: 10, col: 3, package: 'authz-pkg' } }]);
    expect(authz.findings).to.deep.equal([]);
    expect(authz.entryPoints).to.deep.equal([]);
    expect(authz).to.not.have.property('ir');
  });

});
