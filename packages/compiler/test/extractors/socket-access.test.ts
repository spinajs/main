import { expect } from 'chai';
import type { AuthzSection, ManifestFragment, SocketControllerEntry } from '@spinajs/manifest';
import { analyzePackage } from '../../src/index.js';
import { accessRefs } from '../../src/doctor/rules/authz-entries.js';

describe('socket access in the manifest, as http-socket mounts it', () => {
  let fragment: ManifestFragment;
  let share: SocketControllerEntry;
  before(async () => {
    fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-pkg/tsconfig.json', packageRoot: 'test/fixtures/authz-pkg' });
    share = fragment.socketControllers.find((c) => c.className === 'ShareSocket')!;
  });

  const owner = { type: 'OwnerPolicy', options: [] };
  const entry = (id: string): AuthzSection['entryPoints'][number] | undefined => fragment.authz?.entryPoints.find((e) => e.id === id);

  it('names SocketAccessPolicy with the scope of the decorator and keeps the also policies in its group', () => {
    expect(share.policies).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['class'] }, owner]]);
    expect(share.commands.find((c) => c.name === 'blob')?.policies).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['handler'] }, owner]]);
    expect(share.events.find((e) => e.name === 'seen')?.policies).to.deep.equal([[{ type: 'SocketAccessPolicy', options: ['handler'] }]]);
  });

  it('lists the permissions and the unfiltered-input reason on the entry point', () => {
    const classRule = { type: 'SocketAccessPolicy', options: ['doc:read'] };
    const blob = { type: 'SocketAccessPolicy', options: ['doc:share', { unfilteredInput: 'the payload is a signed blob' }] };
    expect(entry('share.blob')?.access).to.deep.equal([[classRule, owner, blob, owner]]);
    expect(entry('share.seen')?.access).to.deep.equal([[classRule, owner, { type: 'SocketAccessPolicy', options: ['doc:read'] }]]);
  });

  it('is an access ref for the doctor rules', () => {
    expect(accessRefs(entry('share.blob')!).map((r) => r.type)).to.deep.equal(['SocketAccessPolicy', 'SocketAccessPolicy']);
  });
});
