import * as chai from 'chai';
import 'mocha';
import type { AuthorizationModel, IRCompileContext } from '@spinajs/authz';

import { canonicalize, combineFromConfig, compilePolicy, parseStoredPolicyName, policyHash, storedPolicyName } from '../../src/index.js';
import type { IRFragment, PolicyIR, PolicyService } from '../../src/index.js';

const expect = chai.expect;

const model = (name: string, toIR?: (ctx: IRCompileContext) => IRFragment): AuthorizationModel => ({ name, ...(toIR ? { toIR } : {}) }) as unknown as AuthorizationModel;
const docFragment = (ctx: IRCompileContext): IRFragment => ({
  model: 'm',
  types: { doc: { relations: { viewer: { allowed: ['user'], source: { kind: 'tuples', store: 'rebac' } } }, permissions: {} } },
  permissions: { 'doc:read': { type: 'doc', permit: 'viewer', source: { origin: `config:${ctx.config('origin', 'x')}` } } },
});
const service = (models: AuthorizationModel[]): PolicyService => ({
  models: () => models,
  irContext: () => ({ config: <T>(_p: string, _d?: T) => 'cfg' as unknown as T }),
});

describe('compilePolicy', () => {
  it('compiles every model with its irContext and stored: opaque by default', async () => {
    const seen: IRCompileContext[] = [];
    const m = model('m', (ctx) => (seen.push(ctx), docFragment(ctx)));
    const p = await compilePolicy(service([m]));
    expect(seen.map((c) => c.stored)).to.deep.equal(['opaque']);
    expect(p.ir.permissions['doc:read'].source.origin).to.equal('config:cfg');
  });

  it('passes stored: include through', async () => {
    const seen: IRCompileContext[] = [];
    await compilePolicy(service([model('m', (ctx) => (seen.push(ctx), docFragment(ctx)))]), { stored: 'include' });
    expect(seen[0].stored).to.equal('include');
  });

  it('hash is sha256 of canonical, and canonical survives a JSON round trip', async () => {
    const p = await compilePolicy(service([model('m', docFragment), model('opaque-one')]));
    expect(p.hash).to.equal(policyHash(p.ir));
    expect(canonicalize(JSON.parse(p.canonical) as PolicyIR)).to.equal(p.canonical);
    expect(p.ir.opaque).to.deep.include({ kind: 'model', name: 'opaque-one' });
  });

  it('is deterministic across model order and independent runs', async () => {
    const memoFragment = (): IRFragment => ({
      model: 'n',
      types: { memo: { relations: { owner: { allowed: ['user'], source: { kind: 'column', model: 'Memo', column: 'author_id' } } }, permissions: {} } },
      permissions: { 'memo:read': { type: 'memo', permit: 'owner', source: { origin: 'config:n' } } },
    });
    const m1 = model('m', docFragment);
    const m2 = model('n', memoFragment);
    const a = await compilePolicy(service([m1, m2]));
    const b = await compilePolicy(service([m2, m1]));
    const c = await compilePolicy(service([m1, m2]));
    expect(a.hash).to.equal(b.hash);
    expect(a.hash).to.equal(c.hash);
    expect(a.canonical).to.equal(b.canonical);
  });

  it('works with a service double without irContext', async () => {
    const p = await compilePolicy({ models: () => [model('m', docFragment)] });
    expect(p.ir.permissions['doc:read'].source.origin).to.equal('config:x');
  });

  it('adds extra fragments and reports conflicts', async () => {
    const extra: IRFragment = { model: 'orm:Doc', types: { doc: { relations: { viewer: { allowed: ['group#member'], source: { kind: 'tuples', store: 'other' } } }, permissions: {} } } };
    const p = await compilePolicy(service([model('m', docFragment)]), { extra: [extra] });
    expect(p.conflicts.map((c) => c.path)).to.deep.equal(['types.doc.relations.viewer']);
  });
});

describe('combineFromConfig', () => {
  it('keeps built-in algorithms and makes custom combinators opaque', () => {
    expect(combineFromConfig({ default: { algorithm: 'deny-overrides' }, types: { doc: { algorithm: 'mine', models: ['a', 'b'] } } })).to.deep.equal({
      default: { algorithm: 'deny-overrides' },
      types: { doc: { algorithm: { opaque: 'mine' }, models: ['a', 'b'] } },
    });
    expect(combineFromConfig(undefined)).to.equal(undefined);
  });
});

describe('stored policy names', () => {
  it('round-trip, with separators in the parts escaped', () => {
    const name = storedPolicyName('abac', 'db:main');
    expect(name).to.equal('stored:abac:db%3Amain');
    expect(parseStoredPolicyName(name)).to.deep.equal({ model: 'abac', store: 'db:main' });
    expect(parseStoredPolicyName('rbac rule r1')).to.equal(undefined);
  });
});
