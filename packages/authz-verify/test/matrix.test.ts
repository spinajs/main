import 'mocha';
import { expect } from 'chai';

import { holderKey, permissionMatrix } from '../src/index.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

describe('permissionMatrix', () => {
  it('rates every holder against every permission', () => {
    const m = permissionMatrix(invoicesIR());
    expect(m.permissions).to.deep.equal(['invoice:approve', 'invoice:read', 'invoice:update']);
    expect(m.holders.map(holderKey)).to.deep.equal(['invoice#owner', 'role:accountant@org', 'role:clerk@$global']);
    expect(m.cells).to.deep.equal({
      'invoice#owner': { 'invoice:approve': 'never', 'invoice:read': 'conditional', 'invoice:update': 'never' },
      'role:accountant@org': { 'invoice:approve': 'always', 'invoice:read': 'always', 'invoice:update': 'conditional' },
      'role:clerk@$global': { 'invoice:approve': 'never', 'invoice:read': 'conditional', 'invoice:update': 'never' },
    });
    expect(m.opaque).to.deep.equal({});
  });

  it('lists the opaque parts each permission depends on', () => {
    const ir = foldersIR();
    ir.opaque = [{ kind: 'model', name: 'legacy' }];
    ir.types.folder.permissions.browse = { union: [{ opaque: 'model:legacy' }, { computed: 'viewer' }] };
    const m = permissionMatrix(ir);
    expect(m.opaque['folder:browse']).to.deep.equal([{ kind: 'model', name: 'legacy' }, { kind: 'rewrite', name: 'model:legacy' }]);
    expect(m.opaque['folder:read']).to.deep.equal([{ kind: 'model', name: 'legacy' }]);
    expect(m.cells['public:folder#viewer']['folder:browse']).to.equal('always');
  });
});
