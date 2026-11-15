import 'mocha';
import { expect } from 'chai';
import { readFileSync, writeFileSync } from 'node:fs';

import { writeOpenFga } from '../../src/index.js';
import type { PolicyIR } from '../../src/index.js';
import { docsIR } from '../fixtures/docs.js';

const fixture = (name: string): URL => new URL(`../fixtures/${name}`, import.meta.url);

/** `UPDATE_GOLDEN=1 npm test` rewrites the golden files; review the diff before committing. */
function golden(name: string, actual: string): void {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(fixture(name), actual);
  expect(actual).to.equal(readFileSync(fixture(name), 'utf8'));
}

const impact = (): PolicyIR => JSON.parse(readFileSync(fixture('impact-3-3.ir.json'), 'utf8')) as PolicyIR;

describe('writeOpenFga', () => {
  it('writes the docs fixture as OpenFGA schema 1.1 with its conditions', () => {
    const { dsl, warnings } = writeOpenFga(docsIR());
    expect(warnings).to.deep.equal(['doc#publish: caveat not_frozen on a rewrite (OpenFGA conditions sit on type restrictions)']);
    golden('docs.fga', dsl);
  });

  it('writes the impact summary 3.3 policy, $global as global', () => {
    const { dsl, warnings } = writeOpenFga(impact());
    expect(dsl).to.contain('type global # spina:$global\n').and.to.contain('define parent: [global] # spina:ancestor {"via":"$global"}');
    expect(dsl).to.contain('define abac_deny_invoice_update: [user:* with abac_frozen_invoices] # spina:rewrite');
    expect(warnings).to.deep.equal([]);
    golden('impact-3-3.fga', dsl);
  });

  it('refuses what OpenFGA cannot express under strict', () => {
    expect(() => writeOpenFga(docsIR(), { strict: true })).to.throw(/--strict: doc#publish: caveat not_frozen/);
  });
});
