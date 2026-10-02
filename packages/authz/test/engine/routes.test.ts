import * as chai from 'chai';
import 'mocha';

import { compileRoutes, DEFAULT_COMBINE } from '../../src/engine/routes.js';
import type { CombineConfig } from '../../src/engine/routes.js';
import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import { AuthorizationModel, AuthzConfigError } from '../../src/contracts/index.js';
import type { ModelCapabilities, PermissionDef, ResourceType, Vote } from '../../src/contracts/index.js';

const expect = chai.expect;

const ALGORITHMS = ['deny-overrides', 'permit-overrides', 'first-applicable'];

class FakeModel extends AuthorizationModel {
  readonly capabilities: ModelCapabilities;
  readonly calls: { permission: string; type: ResourceType }[] = [];

  constructor(readonly name: string, caps: Partial<ModelCapabilities> = {}, private readonly appliesFn: (def: PermissionDef, type: ResourceType) => unknown = () => true) {
    super();
    this.capabilities = { effects: ['permit'], residuals: [], sync: 'always', fields: false, needsSubject: false, ...caps };
  }

  init(): void {}

  applies(def: PermissionDef, type: ResourceType): boolean {
    this.calls.push({ permission: def.name, type });
    return this.appliesFn(def, type) as boolean;
  }

  evaluate(): Vote {
    throw new Error('not used');
  }
}

const registry = (defs: { name: string; types?: string[] }[] = [{ name: 'fs:read', types: ['file', 'folder'] }, { name: 'job:run' }]) => {
  const reg = new PermissionRegistryImpl();
  reg.register(defs, 'test');
  reg.freeze();
  return reg;
};

const compile = (models: AuthorizationModel[], combine: CombineConfig = DEFAULT_COMBINE, reg = registry()) => compileRoutes({ domain: 'app', models, registry: reg, combine, algorithms: ALGORITHMS });

const names = (plan: { models: readonly AuthorizationModel[] } | undefined) => plan?.models.map((m) => m.name);

const expectConfigError = (fn: () => unknown, ...parts: RegExp[]) => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a throw').to.be.instanceOf(AuthzConfigError);
  for (const part of parts) {
    expect((caught as Error).message).to.match(part);
  }
  return caught as AuthzConfigError;
};

describe('compileRoutes', () => {
  it('DEFAULT_COMBINE is deny-overrides and frozen', () => {
    expect(DEFAULT_COMBINE).to.deep.equal({ default: { algorithm: 'deny-overrides' } });
    expect(Object.isFrozen(DEFAULT_COMBINE)).to.equal(true);
    expect(Object.isFrozen(DEFAULT_COMBINE.default)).to.equal(true);
  });

  it('routes every model in registration order under the default config', () => {
    const table = compile([new FakeModel('rbac'), new FakeModel('abac')]);
    const plan = table.get('fs:read', 'file');
    expect(plan?.algorithm).to.equal('deny-overrides');
    expect(names(plan)).to.deep.equal(['rbac', 'abac']);
  });

  it('respects the order of an explicit models list', () => {
    const table = compile([new FakeModel('rbac'), new FakeModel('abac'), new FakeModel('fs')], { default: { algorithm: 'first-applicable', models: ['fs', 'rbac'] } });
    const plan = table.get('fs:read', 'folder');
    expect(plan?.algorithm).to.equal('first-applicable');
    expect(names(plan)).to.deep.equal(['fs', 'rbac']);
  });

  it('uses a per-type override', () => {
    const table = compile([new FakeModel('rbac'), new FakeModel('abac')], { default: { algorithm: 'deny-overrides' }, types: { job: { algorithm: 'permit-overrides', models: ['abac'] } } });
    expect(table.get('job:run', 'job')).to.deep.include({ algorithm: 'permit-overrides' });
    expect(names(table.get('job:run', 'job'))).to.deep.equal(['abac']);
    expect(table.get('job:run', '$global')?.algorithm).to.equal('deny-overrides');
    expect(names(table.get('job:run', '$global'))).to.deep.equal(['rbac', 'abac']);
  });

  it('routes $global for every permission', () => {
    const table = compile([new FakeModel('rbac')]);
    expect(names(table.get('fs:read', '$global'))).to.deep.equal(['rbac']);
    expect(names(table.get('job:run', '$global'))).to.deep.equal(['rbac']);
  });

  it('does not duplicate $global when a def lists it', () => {
    const table = compile([new FakeModel('rbac')], DEFAULT_COMBINE, registry([{ name: 'sys:admin', types: ['$global'] }]));
    expect(table.entries().map((e) => `${e.permission}@${e.type}`)).to.deep.equal(['sys:admin@$global']);
  });

  it('filters by capabilities.resourceTypes', () => {
    const table = compile([new FakeModel('files', { resourceTypes: ['file'] }), new FakeModel('all', { resourceTypes: '*' }), new FakeModel('absent')]);
    expect(names(table.get('fs:read', 'file'))).to.deep.equal(['files', 'all', 'absent']);
    expect(names(table.get('fs:read', 'folder'))).to.deep.equal(['all', 'absent']);
    expect(names(table.get('fs:read', '$global'))).to.deep.equal(['all', 'absent']);
  });

  it('routes only when applies returns exactly true', () => {
    const table = compile([new FakeModel('one', {}, () => 1), new FakeModel('str', {}, () => 'yes'), new FakeModel('only-file', {}, (_d, t) => t === 'file')]);
    expect(names(table.get('fs:read', 'file'))).to.deep.equal(['only-file']);
    expect(names(table.get('fs:read', 'folder'))).to.deep.equal([]);
  });

  it('does not ask applies of a model the resourceTypes filter excludes', () => {
    const m = new FakeModel('files', { resourceTypes: ['file'] });
    compile([m]);
    expect(m.calls.length).to.be.greaterThan(0);
    expect(m.calls.every((c) => c.type === 'file')).to.equal(true);
    expect(m.calls.some((c) => c.type === 'folder' || c.type === '$global')).to.equal(false);
  });

  it('rejects malformed resourceTypes instead of matching substrings', () => {
    expectConfigError(() => compile([new FakeModel('typo', { resourceTypes: 'files' as unknown as string[] })]), /app/, /typo/, /resourceTypes/);
    expectConfigError(() => compile([new FakeModel('obj', { resourceTypes: {} as unknown as string[] })]), /app/, /obj/);
    expectConfigError(() => compile([new FakeModel('mixed', { resourceTypes: ['file', 1] as unknown as string[] })]), /app/, /mixed/);
    expectConfigError(() => compile([new FakeModel('nul', { resourceTypes: null as unknown as string[] })]), /app/, /nul/);
  });

  it('rejects malformed models', () => {
    expectConfigError(() => compile([null as unknown as AuthorizationModel]), /app/);
    expectConfigError(() => compile([{ name: 1, capabilities: {} } as unknown as AuthorizationModel]), /app/);
    const noCaps = new FakeModel('nocaps');
    Object.defineProperty(noCaps, 'capabilities', { value: undefined });
    expectConfigError(() => compile([noCaps]), /app/, /nocaps/, /capabilities/);
    const throwing = new FakeModel('getter');
    const boom = new Error('boom');
    Object.defineProperty(throwing, 'capabilities', {
      get() {
        throw boom;
      },
    });
    const err = expectConfigError(() => compile([throwing]), /app/, /getter/);
    expect((err as Error & { cause?: unknown }).cause).to.equal(boom);
  });

  it('rejects malformed combine config', () => {
    const models = [new FakeModel('rbac')];
    const bad = (combine: unknown) => compile(models, combine as CombineConfig);
    expectConfigError(() => bad(null), /app/);
    expectConfigError(() => bad({}), /app/, /default/);
    expectConfigError(() => bad({ default: 'deny-overrides' }), /app/, /default/);
    expectConfigError(() => bad({ default: { algorithm: 1 } }), /app/, /default/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides', models: 'rbac' } }), /app/, /default/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides', models: [1] } }), /app/, /default/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides' }, types: { job: null } }), /app/, /job/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides' }, types: { job: { algorithm: 'deny-overrides', models: {} } } }), /app/, /job/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides' }, types: [] }), /app/, /types/);
    expectConfigError(() => bad({ default: { algorithm: 'deny-overrides' }, types: 'job' }), /app/, /types/);
  });

  it('wraps a throwing applies with cause and names domain, type, permission and model', () => {
    const boom = new Error('boom');
    const err = expectConfigError(
      () =>
        compile([
          new FakeModel('bad', {}, (d, t) => {
            if (d.name === 'job:run' && t === 'job') throw boom;
            return true;
          }),
        ]),
      /app/,
      /job:run/,
      /"job"|'job'| job\b/,
      /bad/,
    );
    expect((err as Error & { cause?: unknown }).cause).to.equal(boom);
  });

  it('rejects a listed model that is not registered', () => {
    expectConfigError(() => compile([new FakeModel('rbac')], { default: { algorithm: 'deny-overrides', models: ['rbac', 'ghost'] } }), /app/, /ghost/);
    expectConfigError(() => compile([new FakeModel('rbac')], { default: { algorithm: 'deny-overrides' }, types: { job: { algorithm: 'deny-overrides', models: ['ghost'] } } }), /app/, /job/, /ghost/);
  });

  it('rejects a model listed twice in one entry', () => {
    expectConfigError(() => compile([new FakeModel('rbac')], { default: { algorithm: 'deny-overrides', models: ['rbac', 'rbac'] } }), /app/, /rbac/);
  });

  it('rejects two registered models with one name', () => {
    expectConfigError(() => compile([new FakeModel('rbac'), new FakeModel('rbac')]), /app/, /rbac/);
  });

  it('rejects an unknown algorithm', () => {
    expectConfigError(() => compile([new FakeModel('rbac')], { default: { algorithm: 'majority' } }), /app/, /majority/);
    expectConfigError(() => compile([new FakeModel('rbac')], { default: { algorithm: 'deny-overrides' }, types: { job: { algorithm: 'majority' } } }), /app/, /job/, /majority/);
  });

  it('get returns undefined for an unknown pair', () => {
    const table = compile([new FakeModel('rbac')]);
    expect(table.get('fs:read', 'job')).to.equal(undefined);
    expect(table.get('fs:write', 'file')).to.equal(undefined);
    expect(table.get('__proto__', 'file')).to.equal(undefined);
    expect(table.get('fs:read', '__proto__')).to.equal(undefined);
  });

  it('entries covers every (permission, type) pair', () => {
    const table = compile([new FakeModel('rbac')]);
    expect(table.entries().map((e) => `${e.permission}@${e.type}`)).to.deep.equal(['fs:read@file', 'fs:read@folder', 'fs:read@$global', 'job:run@job', 'job:run@$global']);
    for (const e of table.entries()) {
      expect(e.plan).to.equal(table.get(e.permission, e.type));
    }
  });

  it('lists unrouted models when every entry lists models', () => {
    const models = [new FakeModel('rbac'), new FakeModel('abac'), new FakeModel('fs'), new FakeModel('extra')];
    const table = compile(models, { default: { algorithm: 'deny-overrides', models: ['rbac'] }, types: { file: { algorithm: 'first-applicable', models: ['fs', 'rbac'] } } });
    expect(table.unrouted).to.deep.equal(['abac', 'extra']);
  });

  it('has no unrouted models when some entry omits models', () => {
    const models = [new FakeModel('rbac'), new FakeModel('abac')];
    expect(compile(models, { default: { algorithm: 'deny-overrides' }, types: { file: { algorithm: 'deny-overrides', models: ['rbac'] } } }).unrouted).to.deep.equal([]);
    expect(compile(models, { default: { algorithm: 'deny-overrides', models: ['rbac'] }, types: { file: { algorithm: 'deny-overrides' } } }).unrouted).to.deep.equal([]);
  });

  it('freezes the table, its entries and plans', () => {
    const table = compile([new FakeModel('rbac')]);
    const plan = table.get('fs:read', 'file')!;
    expect(Object.isFrozen(table)).to.equal(true);
    expect(Object.isFrozen(plan)).to.equal(true);
    expect(Object.isFrozen(plan.models)).to.equal(true);
    expect(Object.isFrozen(table.entries())).to.equal(true);
    expect(Object.isFrozen(table.entries()[0])).to.equal(true);
    expect(Object.isFrozen(table.unrouted)).to.equal(true);
  });

  it('does not pick up Object.prototype members for prototype-key types', () => {
    const reg = registry([{ name: 'odd:read', types: ['constructor', '__proto__', 'toString', 'hasOwnProperty'] }]);
    const table = compile([new FakeModel('rbac')], { default: { algorithm: 'permit-overrides' }, types: { job: { algorithm: 'deny-overrides', models: [] } } }, reg);
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const plan = table.get('odd:read', type);
      expect(plan?.algorithm, type).to.equal('permit-overrides');
      expect(names(plan), type).to.deep.equal(['rbac']);
    }
  });

  it('uses an own __proto__ entry of a JSON-parsed config', () => {
    const reg = registry([{ name: 'odd:read', types: ['__proto__'] }]);
    const types = JSON.parse('{"__proto__": {"algorithm": "first-applicable", "models": []}}') as Record<string, { algorithm: string; models: string[] }>;
    const table = compile([new FakeModel('rbac')], { default: { algorithm: 'deny-overrides' }, types }, reg);
    expect(table.get('odd:read', '__proto__')).to.deep.equal({ algorithm: 'first-applicable', models: [] });
  });

  it('does not mutate its input', () => {
    const combine = { default: { algorithm: 'deny-overrides', models: ['abac', 'rbac'] } };
    const models = [new FakeModel('rbac'), new FakeModel('abac')];
    compile(models, combine);
    expect(combine).to.deep.equal({ default: { algorithm: 'deny-overrides', models: ['abac', 'rbac'] } });
    expect(models.map((m) => m.name)).to.deep.equal(['rbac', 'abac']);
  });
});
