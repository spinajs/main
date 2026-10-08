import * as chai from 'chai';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { ReferenceAuthz } from './c6/reference.js';
import { CANVAS_FIXTURES_DIR, loadCanvasFixtures, resolveCanvasFixtures } from './fixtures.js';

const expect = chai.expect;

const PINNED_SHA256: Record<string, string> = {
  'capabilities.json': 'b26693eba2a991289a9bc1723630f0f36c321ebda81302c7382c97ffff114a7a',
  'state.json': '9006c921506cb40220da88c09f61d40b3e51faf0c3b30ad0d3bd1e9f90682247',
  'cases.json': 'ee03c2634121d423569059c7272209ff86055c117652d483873774277b7f95a0',
};

const REF_H21 = { allowed: true, role: 'maintainer' };
const REF_H27 = { allowed: true, role: 'viewer' };

const readJson = (name: string): unknown => JSON.parse(readFileSync(CANVAS_FIXTURES_DIR + name, 'utf8'));

describe('canvas C6 fixtures', () => {
  describe('vendored files', () => {
    for (const [name, sha] of Object.entries(PINNED_SHA256)) {
      it(`${name} matches the pinned sha256`, () => {
        const text = readFileSync(CANVAS_FIXTURES_DIR + name, 'utf8').replace(/\r\n/g, '\n');
        expect(createHash('sha256').update(text, 'utf8').digest('hex')).to.equal(sha);
      });

      it(`${name} sha256 is recorded in SOURCE.md`, () => {
        expect(readFileSync(CANVAS_FIXTURES_DIR + 'SOURCE.md', 'utf8')).to.contain(sha);
      });
    }
  });

  describe('loader', () => {
    it('yields 62 cases from cases.json alone', () => {
      const f = loadCanvasFixtures({ extra: false });
      expect(f.cases).to.have.length(62);
      expect(f.cases.every((c) => c.pending === undefined)).to.equal(true);
    });

    it('appends the two pinned cases after the 62', () => {
      const f = loadCanvasFixtures();
      expect(f.cases).to.have.length(64);
      expect(f.cases.map((c) => c.index)).to.deep.equal(f.cases.map((_, i) => i));
      const [h21, h27] = f.cases.slice(62);
      expect(h21).to.include({ name: 'expired link denies an org admin', pending: 'upstream (CV1)', decision: 'H21' });
      expect(h27).to.include({ name: 'external sharing off cuts an existing external grant', pending: 'upstream (CV1)', decision: 'H27' });
      expect(h21.expected).to.deep.equal({ allowed: false, reason: { code: 'link_invalid' } });
      expect(h27.expected).to.deep.equal({ allowed: false, reason: { code: 'no_access' } });
    });

    it('adds the SEALED org and VAULT project from extra-cases', () => {
      const f = loadCanvasFixtures();
      const sealed = f.ids.get('SEALED')!;
      expect(f.state.orgs.get(sealed)?.policies.external_sharing).to.equal(false);
      expect(f.state.projects.get(f.ids.get('VAULT')!)?.org).to.equal(sealed);
      expect(loadCanvasFixtures({ extra: false }).ids.has('SEALED')).to.equal(false);
    });

    it('explicitPolicies holds only the keys the JSON sets', () => {
      const f = loadCanvasFixtures();
      expect(f.explicitPolicies.get(f.ids.get('SEALED')!)).to.deep.equal({ external_sharing: false });
      expect(f.explicitPolicies.get(f.ids.get('ACME')!)).to.deep.equal({});
    });

    it('symbolOf reverses the id map', () => {
      const f = loadCanvasFixtures();
      expect(f.symbolOf(f.ids.get('ADAM')!)).to.equal('ADAM');
      expect(f.symbolOf('unknown')).to.equal('unknown');
    });

    for (const section of ['ids', 'orgs', 'projects'] as const) {
      it(`refuses an extra state key that already exists in ${section}`, () => {
        const state = readJson('state.json') as Record<string, Record<string, unknown>>;
        const existing = Object.keys(state[section])[0];
        const extra = { state: { [section]: { [existing]: section === 'ids' ? 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1' : {} } }, cases: [] };
        expect(() => resolveCanvasFixtures(state, readJson('cases.json'), extra)).to.throw(`extra/state/${section}/${existing}: already defined`);
      });
    }

    it('refuses an unknown section in the extra state', () => {
      expect(() => resolveCanvasFixtures(readJson('state.json'), [], { state: { bogus: {} }, cases: [] })).to.throw('unexpected field');
    });
  });

  describe('reference oracle', () => {
    const f = loadCanvasFixtures();
    const reference = new ReferenceAuthz(f.state);

    it('answers all 62 vendored cases as expected', async () => {
      const failures: string[] = [];
      for (const c of f.cases.filter((x) => x.pending === undefined)) {
        const got = await reference.can(c.principal, c.capability, c.resource);
        if (!isDeepStrictEqual(got, c.expected)) failures.push(`${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}`);
      }
      expect(failures).to.deep.equal([]);
    });

    it('answers the H21 case with the admin shortcut instead of link_invalid', async () => {
      const c = f.cases[62];
      expect(await reference.can(c.principal, c.capability, c.resource)).to.deep.equal(REF_H21);
    });

    it('answers the H27 case without reading external_sharing', async () => {
      const c = f.cases[63];
      expect(await reference.can(c.principal, c.capability, c.resource)).to.deep.equal(REF_H27);
    });
  });
});
