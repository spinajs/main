import 'mocha';
import { expect } from 'chai';

import type { PolicyIR } from '@spinajs/authz-ir';
import { holderKey, outcome, reachers } from '../src/index.js';
import type { ReachPath } from '../src/index.js';
import { docsIR } from './fixtures/docs.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

const show = (p: ReachPath): string => p.steps.map((s) => `${s.via}:${s.type}#${s.relation}`).join(' ');
const holders = (ir: PolicyIR, permission: string): string[] => reachers(ir, permission).map((r) => `${holderKey(r.holder)}${r.conditional ? ' ?' : ''}`);

describe('reachers', () => {
  it('names the role a parent chain reaches and marks holders behind an intersection conditional', () => {
    expect(holders(invoicesIR(), 'invoice:read')).to.deep.equal(['invoice#owner ?', 'role:accountant@org', 'role:clerk@$global ?']);
    const [, accountant] = reachers(invoicesIR(), 'invoice:read');
    expect(accountant.paths.map(show)).to.deep.equal(['ttu:invoice#parent ttu:project#parent computed:org#accountant direct:org#accountant']);
  });

  it('marks holders behind an exclusion conditional and never reaches through its subtract side', () => {
    expect(holders(invoicesIR(), 'invoice:update')).to.deep.equal(['role:accountant@org ?']);
  });

  it('terminates on recursive parent chains and lists the public wildcard as its own holder', () => {
    expect(holders(foldersIR(), 'folder:read')).to.deep.equal(['folder#edit', 'folder#viewer', 'public:folder#viewer']);
    expect(holders(foldersIR(), 'folder:update')).to.deep.equal(['folder#edit']);
  });

  it('keeps the holder of a userset reached through group membership', () => {
    const ir = foldersIR();
    ir.types.group = { relations: { member: { allowed: ['user', 'group#member'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } } }, permissions: {} };
    ir.types.folder.relations.viewer.allowed = ['group#member'];
    expect(holders(ir, 'folder:browse')).to.deep.equal(['folder#viewer']);
    expect(reachers(ir, 'folder:browse')[0].paths.map(show)).to.deep.equal(['computed:folder#viewer direct:folder#viewer direct:group#member']);
  });

  it('returns nothing for an unbound permission', () => {
    expect(reachers(invoicesIR(), 'invoice:delete')).to.deep.equal([]);
  });

  it('instantiates every unconditional path as a minimal tuple set the reference evaluator allows', async () => {
    for (const ir of [invoicesIR(), foldersIR(), docsIR()]) {
      for (const permission of Object.keys(ir.permissions)) {
        for (const r of reachers(ir, permission).filter((x) => !x.conditional)) {
          const truth = await outcome(ir, r.witness, [permission]);
          expect(truth[permission], `${permission} via ${holderKey(r.holder)}`).to.equal('allow');
        }
      }
    }
  });

  it('builds the invoice witness from fresh objects along the chain', () => {
    const [, accountant] = reachers(invoicesIR(), 'invoice:read');
    expect(accountant.witness).to.deep.equal({
      principal: { type: 'user', id: 'u1' },
      resource: { type: 'invoice', id: 'i1' },
      tuples: [
        { object: { type: 'invoice', id: 'i1' }, relation: 'parent', subject: { type: 'project', id: 'p1' } },
        { object: { type: 'project', id: 'p1' }, relation: 'parent', subject: { type: 'org', id: 'o1' } },
        { object: { type: 'org', id: 'o1' }, relation: 'accountant', subject: { type: 'user', id: 'u1' } },
      ],
    });
  });
});
