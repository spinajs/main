import 'mocha';
import { expect } from 'chai';

import { mergeFragments } from '@spinajs/authz-ir';
import type { PolicyIR } from '@spinajs/authz-ir';
import { defineAssertions, describeAssertion, formatResults, releaseSolver, verifyAssertions } from '../src/index.js';
import type { AssertionResult, AssertionSet, SatSolver, VerifyOptions } from '../src/index.js';
import { z3Solver } from '../src/smt/z3.js';
import { foldersIR, invoicesIR } from './fixtures/invoices.js';

function monotoneInvoices(): PolicyIR {
  const ir = invoicesIR();
  ir.types.invoice.permissions.read = { tupleToUserset: { tupleset: 'parent', computed: 'can_invoice_read' } };
  delete ir.permissions['invoice:update'];
  return ir;
}

/** Accountants of a partner org read the invoices of an org: a path across the org boundary. */
function partnerInvoices(): PolicyIR {
  const ir = invoicesIR();
  ir.types.org.relations.partner = { allowed: ['org'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } };
  ir.types.org.permissions.can_invoice_read = { union: [{ computed: 'accountant' }, { tupleToUserset: { tupleset: 'partner', computed: 'accountant' } }] };
  return ir;
}

const NOTE = 'holds for principals without a ceiling: a ceiling whose permissions list invoice:approve and not invoice:read denies invoice:read where invoice:approve stays allowed (implies(a, b, { narrowed: true }) checks it)';
const codes = (results: AssertionResult[]): string[] => results.flatMap((r) => r.diagnostics.map((d) => `${d.code} ${d.severity} ${d.assertion}: ${d.message}`));
const unavailable: VerifyOptions = { solver: () => Promise.resolve(undefined) };

describe('defineAssertions', () => {
  it('builds assertions with the kit and labels them', () => {
    const set = defineAssertions(({ implies, never, isolated, separated, onlyVia }) => [
      implies('invoice:delete', 'invoice:read'),
      separated('invoice:create', 'invoice:approve', { on: 'same-resource' }),
      isolated('org', { except: ['platform.admin'] }),
      onlyVia('payout:send', ['role:treasurer@org']),
      never({ holder: 'public', permission: '*:update' }),
    ]);
    expect(set.assertions.map(describeAssertion)).to.deep.equal([
      'implies(invoice:delete, invoice:read)',
      'separated(invoice:create, invoice:approve)',
      'isolated(org, except platform.admin)',
      'onlyVia(payout:send, [role:treasurer@org])',
      'never(public, *:update)',
    ]);
  });
});

describe('assertions that name a permission the policy does not have', () => {
  const azv006 = (results: AssertionResult[]): string[][] => results.map((r) => r.diagnostics.filter((d) => d.code === 'AZV006').map((d) => `${d.severity} ${d.message}`));

  it('are AZV006 errors with an unknown verdict, so a typo never shows a proof', async () => {
    const set = defineAssertions(({ implies, separated, onlyVia, never }) => [
      never({ holder: 'public', permission: 'nosuch:*' }),
      never({ holder: 'public', permission: 'invoice:aprove' }),
      onlyVia('invoice:aprove', ['role:accountant@org']),
      implies('invoice:aprove', 'invoice:read'),
      separated('invoice:read', 'invoice:aprove'),
      implies('invoice:approve', 'invoice:read'),
    ]);
    const results = await verifyAssertions(monotoneInvoices(), set, unavailable);

    expect(results.map((r) => r.verdict.result)).to.deep.equal(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'holds']);
    expect(results.map((r) => r.verdict.code)).to.deep.equal(['AZV006', 'AZV006', 'AZV006', 'AZV006', 'AZV006', undefined]);
    expect(azv006(results)).to.deep.equal([
      ['error nosuch:* names no permission of the policy'],
      ['error invoice:aprove names no permission of the policy'],
      ['error invoice:aprove names no permission of the policy'],
      ['error invoice:aprove names no permission of the policy'],
      ['error invoice:aprove names no permission of the policy'],
      [],
    ]);
  });

  it('match names by letter case, as the permission registry does', async () => {
    const set = defineAssertions(({ implies, never }) => [never({ holder: 'public', permission: 'Invoice:read' }), never({ holder: 'public', permission: 'INVOICE:*' }), implies('invoice:approve', 'invoice:Read')]);
    expect(azv006(await verifyAssertions(monotoneInvoices(), set, unavailable))).to.deep.equal([
      ['error Invoice:read names no permission of the policy'],
      ['error INVOICE:* names no permission of the policy'],
      ['error invoice:Read names no permission of the policy'],
    ]);
  });

  it('take a glob only in never: elsewhere a glob names no permission, and the empty or blank-padded name is shown quoted', async () => {
    const set = defineAssertions(({ implies, onlyVia, never }) => [
      implies('invoice:*', 'invoice:read'),
      onlyVia('*', []),
      never({ holder: 'public', permission: '' }),
      implies('', 'nosuch:read'),
      never({ holder: 'public', permission: ' invoice:read ' }),
    ]);
    const results = await verifyAssertions(monotoneInvoices(), set, unavailable);
    expect(results.map((r) => r.verdict.result)).to.deep.equal(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(azv006(results)).to.deep.equal([
      ['error invoice:* names no permission of the policy'],
      ['error * names no permission of the policy'],
      ["error '' names no permission of the policy"],
      ["error '', nosuch:read name no permission of the policy"],
      ["error ' invoice:read ' names no permission of the policy"],
    ]);
  });

  it('isolated with a type the policy does not have is AZV006 too; a known type is left to the engines', async () => {
    const set = defineAssertions(({ isolated }) => [isolated('nosuch'), isolated('Org'), isolated(''), isolated(' org '), isolated('org')]);
    const results = await verifyAssertions(monotoneInvoices(), set, unavailable);
    expect(results.map((r) => r.verdict.result)).to.deep.equal(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(codes(results)).to.deep.equal([
      'AZV006 error isolated(nosuch): nosuch names no type of the policy',
      'AZV006 error isolated(Org): Org names no type of the policy',
      "AZV006 error isolated(): '' names no type of the policy",
      "AZV006 error isolated( org ): ' org ' names no type of the policy",
      'AZV090 warning isolated(org): not verified: z3-solver is not installed; non-monotone assertions are not verified',
    ]);
  });

  it('leave a never glob that matches some permissions, and a permission no holder reaches, to the engines', async () => {
    const ir = monotoneInvoices();
    ir.types.org.relations.archiver = { allowed: ['user'], source: { kind: 'tuples', store: 'authz_assignment' } };
    ir.types.invoice.permissions.archive = { tupleToUserset: { tupleset: 'parent', computed: 'archiver' } };
    ir.types.project.permissions.archiver = { tupleToUserset: { tupleset: 'parent', computed: 'archiver' } };
    ir.permissions['invoice:archive'] = { type: 'invoice', relation: 'archive', list: false, source: { origin: 'config:authz' } };
    ir.principal.roles.archiver = [{ type: 'org', relation: 'archiver' }];
    const set = defineAssertions(({ never, onlyVia }) => [never({ holder: 'public', permission: 'invoice:*' }), never({ holder: 'public', permission: 'invoice:archive' }), onlyVia('invoice:archive', ['role:archiver@org'])]);
    const results = await verifyAssertions(ir, set, unavailable);
    expect(codes(results)).to.deep.equal([
      'AZV002 info never(public, invoice:*): holds (exact)',
      'AZV002 info never(public, invoice:archive): holds (exact)',
      'AZV002 info onlyVia(invoice:archive, [role:archiver@org]): holds (exact)',
    ]);
  });

  it('know a permission that another model of the merged policy defines', async () => {
    const { ir, conflicts } = mergeFragments([
      { model: 'rbac', types: { user: { relations: {}, permissions: {} }, doc: { relations: { reader: { allowed: ['user'], source: { kind: 'tuples', store: 'authz_assignment' } } }, permissions: {} } }, permissions: { 'doc:read': { type: 'doc', permit: 'reader', source: { origin: 'config:authz' } } } },
      { model: 'rebac', types: { doc: { relations: { sharer: { allowed: ['user'], source: { kind: 'tuples', store: 'authz_rebac_tuple' } } }, permissions: {} } }, permissions: { 'doc:share': { type: 'doc', permit: 'sharer', source: { origin: 'config:authz', file: 'policies/share.ts' } } } },
    ]);
    expect(conflicts).to.deep.equal([]);
    const set = defineAssertions(({ never }) => [never({ holder: 'public', permission: 'doc:share' }), never({ holder: 'public', permission: 'doc:shrae' })]);
    expect(codes(await verifyAssertions(ir, set, unavailable))).to.deep.equal(['AZV002 info never(public, doc:share): holds (exact)', 'AZV006 error never(public, doc:shrae): doc:shrae names no permission of the policy']);
  });

  it('report no opaque part for an assertion that was never analysed', async () => {
    const ir = monotoneInvoices();
    ir.opaque = [{ kind: 'model', name: 'legacy' }];
    const [r] = await verifyAssertions(ir, defineAssertions(({ never }) => [never({ holder: 'public', permission: 'invoice:aprove' })]), unavailable);
    expect(codes([r])).to.deep.equal(['AZV006 error never(public, invoice:aprove): invoice:aprove names no permission of the policy']);
    expect(r.verdict.opaque).to.deep.equal([]);
  });
});

describe('verifyAssertions with the exact engine', () => {
  it('decides the monotone fragment without a solver', async () => {
    const set = defineAssertions(({ implies, never, onlyVia, separated }) => [
      implies('invoice:approve', 'invoice:read'),
      onlyVia('invoice:approve', ['role:treasurer@org']),
      never({ holder: 'public', permission: 'invoice:*' }),
      separated('invoice:read', 'invoice:approve'),
    ]);
    const results = await verifyAssertions(monotoneInvoices(), set, unavailable);
    expect(codes(results)).to.deep.equal([
      'AZV002 info implies(invoice:approve, invoice:read): holds (exact)',
      `AZV004 info implies(invoice:approve, invoice:read): ${NOTE}`,
      'AZV001 error onlyVia(invoice:approve, [role:treasurer@org]): violated (exact)',
      'AZV002 info never(public, invoice:*): holds (exact)',
      'AZV001 error separated(invoice:read, invoice:approve): violated (exact)',
    ]);
    expect(results[3].verdict.counterexample!.outcome).to.deep.equal({ 'invoice:read': 'allow', 'invoice:approve': 'allow' });
  });

  it('finds a public holder and confirms its witness', async () => {
    const [r] = await verifyAssertions(foldersIR(), defineAssertions(({ never }) => [never({ holder: 'public', permission: 'folder:read' })]), unavailable);
    expect(r.verdict.result).to.equal('violated');
    expect(r.verdict.counterexample!.tuples).to.deep.equal([{ object: { type: 'folder', id: 'f1' }, relation: 'viewer', subject: { type: 'user', id: '*' } }]);
  });

  it('reports AZV090 where only the bounded engine could decide, as an error under requireSolver', async () => {
    const set = defineAssertions(({ implies }) => [implies('invoice:read', 'invoice:approve')]);
    expect(codes(await verifyAssertions(invoicesIR(), set, unavailable))[0]).to.match(/^AZV090 warning/);
    expect(codes(await verifyAssertions(invoicesIR(), set, { ...unavailable, requireSolver: true }))[0]).to.match(/^AZV090 error/);
  });

  it('warns about opaque parts with AZV003', async () => {
    const ir = monotoneInvoices();
    ir.opaque = [{ kind: 'model', name: 'legacy' }];
    const [r] = await verifyAssertions(ir, defineAssertions(({ implies }) => [implies('invoice:approve', 'invoice:read')]), unavailable);
    expect(codes([r])).to.deep.equal([
      'AZV002 info implies(invoice:approve, invoice:read): holds (exact)',
      "AZV003 warning implies(invoice:approve, invoice:read): depends on opaque: model 'legacy'",
      `AZV004 info implies(invoice:approve, invoice:read): ${NOTE}`,
    ]);
  });
});

describe('verifyAssertions with the bounded engine', function () {
  this.timeout(120_000);
  let z3: SatSolver | undefined;
  const run = (ir: PolicyIR, set: AssertionSet): Promise<AssertionResult[]> => verifyAssertions(ir, set, { k: 2, solver: () => Promise.resolve(z3) });

  before(async function () {
    z3 = await z3Solver();
    if (z3 === undefined) {
      console.log('    z3-solver is not installed: bounded assertion tests skipped');
      this.skip();
    }
  });
  after(() => releaseSolver());

  it('falls back to the bounded engine where the exact one answers unknown', async () => {
    const results = await run(
      invoicesIR(),
      defineAssertions(({ implies, never, separated }) => [implies('invoice:read', 'invoice:approve'), implies('invoice:approve', 'invoice:read'), never({ holder: 'role:clerk@$global', permission: 'invoice:read' }), separated('invoice:update', 'invoice:read')]),
    );
    expect(codes(results)).to.deep.equal([
      'AZV001 error implies(invoice:read, invoice:approve): violated (bounded k=2)',
      'AZV002 info implies(invoice:approve, invoice:read): verified up to k=2',
      `AZV004 info implies(invoice:approve, invoice:read): ${NOTE}`,
      'AZV002 info never(role:clerk@$global, invoice:read): verified up to k=2',
      'AZV001 error separated(invoice:update, invoice:read): violated (bounded k=2)',
    ]);
  });

  it('proves isolation up to the bound and finds a path across the boundary', async () => {
    const set = defineAssertions(({ isolated }) => [isolated('org')]);
    expect(codes(await run(invoicesIR(), set))).to.deep.equal(['AZV002 info isolated(org): verified up to k=2']);
    const [crossing] = await run(partnerInvoices(), set);
    expect(crossing.verdict.result).to.equal('violated');
    expect(crossing.verdict.counterexample!.tuples.some((t) => t.relation === 'partner')).to.equal(true);
    const [excepted] = await run(partnerInvoices(), defineAssertions(({ isolated }) => [isolated('org', { except: ['role:accountant@org'] })]));
    expect(excepted.verdict.result).to.equal('holds');
  });
});

describe('formatResults', () => {
  it('prints text, json and GitHub annotations in the doctor shapes', async () => {
    const results = await verifyAssertions(monotoneInvoices(), defineAssertions(({ implies, onlyVia }) => [implies('invoice:approve', 'invoice:read'), onlyVia('invoice:approve', ['org#auditor'])]), unavailable);
    expect(formatResults(results, 'text')).to.deep.equal([
      'ok   AZV002 implies(invoice:approve, invoice:read)   holds (exact)',
      `ok   AZV004 implies(invoice:approve, invoice:read)   ${NOTE}`,
      'fail AZV001 onlyVia(invoice:approve, [org#auditor])  violated (exact)',
      '     principal user:u1 with invoice:i1#parent@project:p1, project:p1#parent@org:o1, org:o1#accountant@user:u1 gets invoice:approve allow on invoice:i1',
      '1 error(s), 0 warning(s), 2 info',
    ]);
    const json = JSON.parse(formatResults(results, 'json')[0]) as { summary: unknown };
    expect(json.summary).to.deep.equal({ error: 1, warning: 0, info: 2 });
    expect(formatResults(results, 'github')[2]).to.equal('::error title=AZV001 onlyVia(invoice%3Aapprove%2C [org#auditor])::violated (exact): principal user:u1 with invoice:i1#parent@project:p1, project:p1#parent@org:o1, org:o1#accountant@user:u1 gets invoice:approve allow on invoice:i1');
  });
});
