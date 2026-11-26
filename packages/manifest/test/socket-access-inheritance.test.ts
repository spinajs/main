import 'mocha';
import { expect } from 'chai';
import { inheritSocketHandlers, type SocketControllerEntry } from '../src/index.js';

const source = { file: 'src/s.ts', line: 1, col: 1, package: 'app' };
const entry = (partial: Partial<SocketControllerEntry>): SocketControllerEntry => ({ id: 'app:S', className: 'S', prefix: '', commands: [], events: [], source, ...partial });
const admin = [{ type: 'AdminPolicy', options: [] }];
const own = { type: 'SocketAccessPolicy', options: ['class'] };

describe('inheritSocketHandlers: the class access group', () => {
  it("replaces the base's SocketAccessPolicy group with the subclass's own", () => {
    const base = entry({ id: 'app:Base', className: 'Base', access: ['doc:read'], policies: [admin, [own]] });
    const sub = entry({ access: ['doc:update'], policies: [[own, { type: 'OwnerPolicy', options: [] }]] });
    expect(inheritSocketHandlers(sub, [base]).policies).to.deep.equal([admin, [own, { type: 'OwnerPolicy', options: [] }]]);
  });

  it('still reads the AccessPolicy name a fragment of an older compiler carries', () => {
    const base = entry({ id: 'dep:Base', className: 'Base', access: ['doc:read'], policies: [[{ type: 'AccessPolicy', options: ['class'] }]] });
    const sub = entry({ access: ['doc:update'], policies: [[own]] });
    expect(inheritSocketHandlers(sub, [base]).policies).to.deep.equal([[own]]);
  });
});
