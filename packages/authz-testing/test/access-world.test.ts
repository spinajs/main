import 'mocha';
import { expect } from 'chai';
import * as fc from 'fast-check';

import { ACCESS_PERMISSIONS, ACCESS_ROLES, arb, validateWorld } from '../src/index.js';

describe('arb.accessWorld', () => {
  it('builds valid worlds whose rows only point at earlier parents', () => {
    fc.assert(
      fc.property(arb.accessWorld(), ({ world, users }) => {
        expect(validateWorld(world)).to.deep.equal([]);
        const [org, project, doc] = world.lane!.orm!.models;
        expect([org.name, project.name, doc.name]).to.deep.equal(['Org', 'Project', 'Doc']);
        const orgs = new Set((org.rows ?? []).map((r) => r.id));
        const projects = new Set((project.rows ?? []).map((r) => r.id));
        for (const r of project.rows ?? []) expect(orgs.has(r.org_id as string)).to.equal(true);
        for (const r of doc.rows ?? []) {
          expect(projects.has(r.project_id as string)).to.equal(true);
          expect(users).to.include(r.owner);
        }
        for (const a of world.rbac!.assignments ?? []) expect(Object.keys(ACCESS_ROLES)).to.include(a.role);
        const keys = (world.rbac!.assignments ?? []).map((a) => JSON.stringify([a.subject, a.role, a.scope]));
        expect(new Set(keys).size, 'assignments unique by subject, role and scope (authz_assignment_uq)').to.equal(keys.length);
        expect(world.permissions).to.deep.equal(ACCESS_PERMISSIONS);
      }),
      { numRuns: 50 },
    );
  });
});
