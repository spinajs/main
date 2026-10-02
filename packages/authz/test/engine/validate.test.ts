import * as chai from 'chai';
import 'mocha';

import { validateBoot } from '../../src/engine/validate.js';
import type { BootInput } from '../../src/engine/validate.js';
import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import { AuthorizationModel, AuthzConfigError, NativeFilter, RelationResolver, ResourceAdapter, ScopeResolver } from '../../src/contracts/index.js';
import type { FilterOp, ModelCapabilities, PermissionDef, ResourceRef, ResourceType, Vote } from '../../src/contracts/index.js';

const expect = chai.expect;

class FakeModel extends AuthorizationModel {
  readonly capabilities: ModelCapabilities;
  readonly forbidden: string[] = [];

  constructor(readonly name: string, caps: Partial<ModelCapabilities> = {}, private readonly appliesFn: (def: PermissionDef, type: ResourceType) => boolean = () => true) {
    super();
    this.capabilities = { effects: ['permit'], residuals: [], sync: 'always', fields: false, needsSubject: false, ...caps };
  }

  init(): void {
    this.forbidden.push('init');
  }

  applies(def: PermissionDef, type: ResourceType): boolean {
    return this.appliesFn(def, type);
  }

  evaluate(): Vote {
    this.forbidden.push('evaluate');
    throw new Error('evaluate must not run at boot');
  }

  async preload(): Promise<void> {
    this.forbidden.push('preload');
  }

  async summarize(): Promise<never> {
    this.forbidden.push('summarize');
    throw new Error('summarize must not run at boot');
  }
}

class FakeAdapter extends ResourceAdapter {
  relationCalls = 0;

  constructor(readonly kind: string, readonly types: readonly ResourceType[], readonly compiles?: readonly FilterOp[], private readonly rels: readonly RelationResolver[] | (() => never) = []) {
    super();
  }

  accepts(_target: unknown): _target is unknown {
    return false;
  }

  refOf(): ResourceRef {
    throw new Error('not used');
  }

  ancestors(): Promise<null> {
    throw new Error('ancestors must not run at boot');
  }

  relations(): readonly RelationResolver[] {
    this.relationCalls++;
    return typeof this.rels === 'function' ? this.rels() : this.rels;
  }
}

class FakeResolver extends ScopeResolver {
  constructor(readonly types: readonly ResourceType[]) {
    super();
  }

  ancestors(): Promise<null> {
    throw new Error('ancestors must not run at boot');
  }
}

class FakeRelation extends RelationResolver {
  constructor(readonly type: ResourceType, readonly relation: string) {
    super();
  }

  holds(): boolean {
    throw new Error('holds must not run at boot');
  }
}

class FakeNative extends NativeFilter {
  constructor(readonly op: `native:${string}`) {
    super();
  }

  matches(): boolean {
    throw new Error('matches must not run at boot');
  }
}

const registry = (defs: { name: string; types?: string[]; implies?: string[] }[] = [{ name: 'fs:read', types: ['file', 'folder'] }, { name: 'job:run' }], freeze = true) => {
  const reg = new PermissionRegistryImpl();
  reg.register(defs, 'test');
  if (freeze) reg.freeze();
  return reg;
};

const input = (over: Partial<BootInput> = {}): BootInput => ({ domain: 'app', models: [new FakeModel('rbac')], registry: registry(), ...over });

const problems = (over: Partial<BootInput>): string => {
  let caught: unknown;
  try {
    validateBoot(input(over));
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected validateBoot to throw').to.be.instanceOf(AuthzConfigError);
  return (caught as Error).message;
};

const lines = (message: string) => message.split('\n').slice(1);

const passes = (over: Partial<BootInput>) => validateBoot(input(over));

describe('validateBoot', () => {
  it('accepts a valid config and returns frozen, empty warnings', () => {
    const result = passes({});
    expect(result.warnings).to.deep.equal([]);
    expect(Object.isFrozen(result)).to.equal(true);
    expect(Object.isFrozen(result.warnings)).to.equal(true);
  });

  it('starts the message with the domain and the problem count', () => {
    const message = problems({ combine: { default: { algorithm: 'deny-overrides', models: ['ghost', 'phantom'] } } });
    expect(message.split('\n')[0]).to.equal('Authorization config of domain "app" is invalid (2 problems):');
    expect(lines(message)).to.have.length(2);
  });

  it('says "1 problem" for a single problem', () => {
    const message = problems({ combine: { default: { algorithm: 'deny-overrides', models: ['ghost'] } } });
    expect(message.split('\n')[0]).to.equal('Authorization config of domain "app" is invalid (1 problem):');
  });

  describe('rule 1: combine lists unregistered models', () => {
    it('reports every unknown name of every entry', () => {
      const message = problems({ combine: { default: { algorithm: 'deny-overrides', models: ['ghost', 'rbac'] }, types: { file: { algorithm: 'deny-overrides', models: ['phantom'] } } } });
      const out = lines(message);
      expect(out).to.have.length(2);
      expect(out[0]).to.match(/^\[6\.5\/1\] domain "app", model "ghost": /);
      expect(out[0]).to.contain('combine.default');
      expect(out[1]).to.match(/^\[6\.5\/1\] domain "app", type "file", model "phantom": /);
    });

    it('passes when every listed model is registered', () => {
      expect(passes({ combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } } }).warnings).to.deep.equal([]);
    });
  });

  describe('rule 2: duplicate model names', () => {
    it('reports a name registered twice once', () => {
      const out = lines(problems({ models: [new FakeModel('rbac'), new FakeModel('abac'), new FakeModel('rbac'), new FakeModel('rbac')] }));
      expect(out).to.deep.equal(['[6.5/2] domain "app", model "rbac": 3 models are registered with this name']);
    });

    it('passes with distinct names', () => {
      passes({ models: [new FakeModel('rbac'), new FakeModel('abac')] });
    });
  });

  describe('rule 3: two adapters for one type', () => {
    it('reports the type and the adapters', () => {
      const out = lines(problems({ adapters: [new FakeAdapter('orm', ['file', 'user']), new FakeAdapter('fs', ['file'])] }));
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[6\.5\/3\] domain "app", type "file": /);
      expect(out[0]).to.contain('"orm"').and.contain('"fs"');
    });

    it('passes with disjoint types, and one adapter repeating its own type is no conflict', () => {
      passes({ adapters: [new FakeAdapter('orm', ['user', 'user']), new FakeAdapter('fs', ['file'])] });
    });
  });

  describe('rule 4: residual ops the type cannot evaluate', () => {
    it('reports ops the list-scoped adapter does not compile, per route', () => {
      const out = lines(problems({ models: [new FakeModel('abac', { residuals: ['cmp', 'relation', 'under'] })], adapters: [new FakeAdapter('orm', ['file'], ['cmp'])] }));
      expect(out).to.deep.equal(['[6.5/4] domain "app", type "file", permission "fs:read", model "abac": residual ops "relation", "under" are not compiled by adapter "orm"']);
    });

    it('passes when the adapter compiles every op', () => {
      passes({ models: [new FakeModel('abac', { residuals: ['cmp', 'relation'] })], adapters: [new FakeAdapter('orm', ['file'], ['cmp', 'relation'])] });
    });

    it('never counts structural ops as uncompiled', () => {
      passes({ models: [new FakeModel('abac', { residuals: ['true', 'false', 'and', 'or', 'not', 'cmp'] })], adapters: [new FakeAdapter('orm', ['file'], ['cmp'])] });
    });

    it('applies only to types whose adapter defines compiles', () => {
      passes({ models: [new FakeModel('abac', { residuals: ['cmp', 'relation', 'under'] })], adapters: [new FakeAdapter('fs', ['file'])] });
    });

    it('skips models that are not routed to the type', () => {
      passes({ models: [new FakeModel('abac', { residuals: ['relation'], resourceTypes: ['folder'] }), new FakeModel('rebac', { residuals: ['relation'] }, (_def, type) => type !== 'file')], adapters: [new FakeAdapter('orm', ['file'], ['cmp'])] });
    });

    it('reports a native op without a NativeFilter on every route, also without an adapter', () => {
      const out = lines(problems({ models: [new FakeModel('geo', { residuals: ['native:geo'] })], registry: registry([{ name: 'job:run' }]) }));
      expect(out).to.deep.equal(['[6.5/4] domain "app", type "$global", permission "job:run", model "geo": native residual op "native:geo" has no registered NativeFilter', '[6.5/4] domain "app", type "job", permission "job:run", model "geo": native residual op "native:geo" has no registered NativeFilter']);
    });

    it('passes a native op with its NativeFilter on a type without an adapter', () => {
      passes({ models: [new FakeModel('geo', { residuals: ['native:geo'] })], nativeFilters: [new FakeNative('native:geo')] });
    });

    it('still requires a native op to be compiled by a list-scoped adapter', () => {
      const out = lines(problems({ models: [new FakeModel('geo', { residuals: ['native:geo'] }, (_def, type) => type === 'file')], adapters: [new FakeAdapter('orm', ['file'], ['cmp'])], nativeFilters: [new FakeNative('native:geo')] }));
      expect(out).to.deep.equal(['[6.5/4] domain "app", type "file", permission "fs:read", model "geo": residual ops "native:geo" are not compiled by adapter "orm"']);
    });
  });

  describe('rule 5: first-applicable with an effectless model', () => {
    it('reports the route', () => {
      const out = lines(problems({ models: [new FakeModel('audit', { effects: [] }, (_def, type) => type === 'file')], combine: { default: { algorithm: 'deny-overrides' }, types: { file: { algorithm: 'first-applicable' } } } }));
      expect(out).to.deep.equal(['[6.5/5] domain "app", type "file", permission "fs:read", model "audit": first-applicable route with a model whose effects are empty']);
    });

    it('passes under another algorithm or with effects', () => {
      passes({ models: [new FakeModel('audit', { effects: [] })] });
      passes({ models: [new FakeModel('audit', { effects: ['deny'] })], combine: { default: { algorithm: 'first-applicable' } } });
    });
  });

  describe('rule 6: join types routed to sync never models', () => {
    it('reports the route', () => {
      const out = lines(problems({ models: [new FakeModel('remote', { sync: 'never' }, (def) => def.name === 'fs:read')], joinTypes: ['folder'] }));
      expect(out).to.deep.equal(['[6.5/6] domain "app", type "folder", permission "fs:read", model "remote": join type routed to a model with sync "never"']);
    });

    it('passes for sync models and for types that are not join types', () => {
      passes({ models: [new FakeModel('rbac', { sync: 'after-preload' })], joinTypes: ['folder'] });
      passes({ models: [new FakeModel('remote', { sync: 'never' })], joinTypes: ['user'] });
    });
  });

  describe('rule 7: permission references', () => {
    it('reports unregistered permissions, foreign types and unregistered implies', () => {
      const out = lines(
        problems({
          registry: registry([{ name: 'fs:read', types: ['file'], implies: ['fs:stat'] }], false),
          permissionRefs: [
            { permission: 'fs:wipe', source: '@Access FilesController.wipe' },
            { permission: 'fs:read', type: 'user', source: 'rbac rule r1' },
          ],
        }),
      );
      expect(out).to.deep.equal(['[6.5/7] domain "app", permission "fs:read": implies "fs:stat", which is not registered', '[6.5/7] domain "app", permission "fs:wipe": referenced by @Access FilesController.wipe but not registered', '[6.5/7] domain "app", type "user", permission "fs:read": rbac rule r1 checks it on a type outside its types ("file")']);
    });

    it('passes registered refs on their types and on $global', () => {
      passes({
        permissionRefs: [
          { permission: 'fs:read', type: 'folder', source: 'a' },
          { permission: 'fs:read', type: '$global', source: 'b' },
          { permission: 'job:run', source: 'c' },
        ],
      });
    });

    it('reports a non-string permission ref fail closed', () => {
      const out = lines(problems({ permissionRefs: [{ permission: 42 as unknown as string, source: 'yaml' }] }));
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[6\.5\/7\] domain "app", permission "42": /);
    });
  });

  describe('rule 8: relations without a resolver', () => {
    it('reports the type and relation', () => {
      const out = lines(problems({ relations: [new FakeRelation('folder', 'owner')], relationRefs: [{ type: 'file', relation: 'owner', source: 'rbac grant g1' }] }));
      expect(out).to.deep.equal(['[6.5/8] domain "app", type "file": relation "owner" used by rbac grant g1 has no RelationResolver']);
    });

    it('passes with a resolver from relations or from an adapter', () => {
      passes({ relations: [new FakeRelation('file', 'owner')], relationRefs: [{ type: 'file', relation: 'owner', source: 'g1' }] });
      passes({ adapters: [new FakeAdapter('fs', ['file'], undefined, [new FakeRelation('file', 'editor')])], relationRefs: [{ type: 'file', relation: 'editor', source: 'g1' }] });
    });

    it('reports an adapter whose relations() throws', () => {
      const out = lines(
        problems({
          adapters: [
            new FakeAdapter('fs', ['file'], undefined, () => {
              throw new Error('boom');
            }),
          ],
        }),
      );
      expect(out).to.have.length(1);
      expect(out).to.deep.equal(['[6.5/8] domain "app", type "file": adapter "fs" threw from relations(): boom']);
    });
  });

  describe('rule 10: scope refs without an ancestor source', () => {
    it('reports the type', () => {
      const out = lines(problems({ scopeRefs: [{ type: 'org', source: 'abac rule org-only' }] }));
      expect(out).to.deep.equal(['[6.5/10] domain "app", type "org": referenced by abac rule org-only, but no adapter or scope resolver returns it as an ancestor']);
    });

    it('passes with an adapter, a scope resolver, or $global', () => {
      passes({ adapters: [new FakeAdapter('orm', ['org'])], scopeRefs: [{ type: 'org', source: 'a' }] });
      passes({ scopeResolvers: [new FakeResolver(['org'])], scopeRefs: [{ type: 'org', source: 'a' }] });
      passes({ scopeRefs: [{ type: '$global', source: 'a' }] });
    });
  });

  describe('algorithms and route compile errors', () => {
    it('reports an unknown algorithm and accepts a registered combinator name', () => {
      const out = lines(problems({ combine: { default: { algorithm: 'majority' } } }));
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[combine\] domain "app": combine\.default names unknown algorithm "majority"/);
      passes({ combine: { default: { algorithm: 'majority' } }, combinators: ['majority'] });
    });

    it('reports a model listed twice in one entry', () => {
      const out = lines(problems({ combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'rbac'] } } }));
      expect(out).to.deep.equal(['[combine] domain "app", model "rbac": combine.default lists the model twice']);
    });

    it('reports a malformed combine config', () => {
      const out = lines(problems({ combine: { default: { algorithm: 'deny-overrides', models: 'rbac' as unknown as string[] } } }));
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[combine\] domain "app": /);
    });

    it('reports applies() throwing as a route compile error', () => {
      const out = lines(
        problems({
          models: [
            new FakeModel('rbac', {}, () => {
              throw new Error('kaput');
            }),
          ],
        }),
      );
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[routes\] domain "app": .*"rbac".*applies\(\)/);
    });

    it('keeps checking routes after combine problems', () => {
      const out = lines(problems({ models: [new FakeModel('rbac', { effects: [] })], combine: { default: { algorithm: 'first-applicable', models: ['rbac', 'ghost'] } } }));
      expect(out[0]).to.match(/^\[6\.5\/1\] /);
      expect(out.slice(1).every((l) => l.startsWith('[6.5/5] '))).to.equal(true);
      expect(out).to.have.length(1 + 5);
    });
  });

  describe('review fixes', () => {
    it('does not report rule 1 for a combine entry naming a rule-2 duplicate', () => {
      const out = lines(problems({ models: [new FakeModel('rbac'), new FakeModel('rbac'), new FakeModel('abac')], combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] } } }));
      expect(out).to.deep.equal(['[6.5/2] domain "app", model "rbac": 2 models are registered with this name']);
    });

    it('falls back from an unknown algorithm in a types entry without a false rule 5', () => {
      const out = lines(problems({ models: [new FakeModel('audit', { effects: [] })], combine: { default: { algorithm: 'deny-overrides' }, types: { file: { algorithm: 'majority' } } } }));
      expect(out).to.have.length(1);
      expect(out[0]).to.match(/^\[combine\] domain "app", type "file": combine\.types\["file"\] names unknown algorithm "majority"/);
    });

    it('reports malformed entries in the one AuthzConfigError instead of throwing a TypeError', () => {
      const nullName = Object.create(null) as object;
      const message = problems({
        models: [null as unknown as AuthorizationModel, { name: 7, capabilities: {} } as unknown as AuthorizationModel, new FakeModel('rbac')],
        combinators: 'xyz' as unknown as string[],
        combine: { default: { algorithm: 'deny-overrides', models: [nullName as unknown as string] } },
        adapters: [null as unknown as ResourceAdapter],
        scopeRefs: [{ type: 42 as unknown as string, source: nullName as unknown as string }, null as unknown as { type: string; source: string }],
        relationRefs: [{ type: nullName as unknown as string, relation: 'owner', source: 's' }],
        permissionRefs: [{ permission: nullName as unknown as string, source: 's' }],
      });
      const out = lines(message);
      expect(out.length).to.be.greaterThan(5);
      expect(out.every((l) => /^\[[^\]]+\] domain "app"/.test(l))).to.equal(true);
      expect(message).to.contain('[6.5/10]').and.contain('[6.5/8]').and.contain('[6.5/7]').and.contain('[combine]').and.contain('[models]').and.contain('[6.5/3]');
      expect(message).not.to.contain('check failed');
    });

    it('reports malformed capabilities and resourceTypes as problems and keeps checking the other models', () => {
      const out = lines(problems({ models: [new FakeModel('bad', { resourceTypes: 'file' as unknown as string[] }), { name: 'nocaps', capabilities: null } as unknown as AuthorizationModel, new FakeModel('audit', { effects: [] })], combine: { default: { algorithm: 'first-applicable' } } }));
      expect(out.filter((l) => l.startsWith('[models] '))).to.have.length(2);
      expect(out.some((l) => l.includes('model "bad"') && l.includes('resourceTypes'))).to.equal(true);
      expect(out.some((l) => l.includes('model "nocaps"') && l.includes('capabilities'))).to.equal(true);
      expect(out.filter((l) => l.startsWith('[6.5/5] '))).to.have.length(5);
      expect(out.some((l) => l.startsWith('[routes] '))).to.equal(false);
    });

    it('reports an op that is not a FilterOp as rule 4 on every route', () => {
      const out = lines(problems({ models: [new FakeModel('odd', { residuals: ['regex' as FilterOp, 42 as unknown as FilterOp, 'native:' as FilterOp, 'cmp'] })], registry: registry([{ name: 'job:run' }]) }));
      expect(out).to.deep.equal(['[6.5/4] domain "app", type "$global", permission "job:run", model "odd": unknown residual ops "42", "native:", "regex"', '[6.5/4] domain "app", type "job", permission "job:run", model "odd": unknown residual ops "42", "native:", "regex"']);
    });

    it('checks an own __proto__ key of combine.types like any other key', () => {
      const combine = JSON.parse('{"default":{"algorithm":"deny-overrides"},"types":{"__proto__":{"algorithm":"first-applicable"}}}');
      const out = lines(problems({ models: [new FakeModel('audit', { effects: [] })], registry: registry([{ name: 'x:y', types: ['__proto__'] }]), combine }));
      expect(out).to.deep.equal(['[6.5/5] domain "app", type "__proto__", permission "x:y", model "audit": first-applicable route with a model whose effects are empty']);
    });
  });

  describe('several violations', () => {
    const build = (reverse: boolean): Partial<BootInput> => {
      const order = <T>(xs: T[]) => (reverse ? [...xs].reverse() : xs);
      return {
        models: order([new FakeModel('zeta', { residuals: ['relation'] }), new FakeModel('alpha', { residuals: ['under'] }), new FakeModel('alpha')]),
        adapters: order([new FakeAdapter('orm', ['file'], ['cmp']), new FakeAdapter('fs', ['file'], ['cmp'])]),
        permissionRefs: order([
          { permission: 'x:b', source: 's' },
          { permission: 'x:a', source: 's' },
        ]),
        scopeRefs: order([
          { type: 'team', source: 's' },
          { type: 'org', source: 's' },
        ]),
        relationRefs: order([{ type: 'file', relation: 'owner', source: 's' }]),
      };
    };

    it('lists them all in a stable order independent of input order', () => {
      const a = problems(build(false));
      const b = problems(build(true));
      expect(a).to.equal(b);
      const rules = lines(a).map((l) => /^\[([^\]]+)\]/.exec(l)![1]);
      expect(rules).to.deep.equal([...rules].sort((x, y) => rank(x) - rank(y)));
      expect(rules).to.include.members(['6.5/2', '6.5/3', '6.5/4', '6.5/7', '6.5/8', '6.5/10']);
      expect(a).to.contain('model "alpha"').and.contain('model "zeta"').and.contain('permission "x:a"').and.contain('type "org"');
    });
  });

  describe('warnings', () => {
    it('lists models that no combine entry routes', () => {
      const result = passes({ models: [new FakeModel('rbac'), new FakeModel('zeta'), new FakeModel('abac')], combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } } });
      expect(result.warnings).to.deep.equal(['domain "app", model "abac": no combine entry routes this model', 'domain "app", model "zeta": no combine entry routes this model']);
    });
  });

  describe('side effects', () => {
    it('never calls evaluate, preload, summarize, init or IO, and calls relations() once per adapter', () => {
      const model = new FakeModel('abac', { residuals: ['cmp'] });
      const adapter = new FakeAdapter('orm', ['file'], ['cmp'], [new FakeRelation('file', 'owner')]);
      passes({ models: [model], adapters: [adapter], scopeResolvers: [new FakeResolver(['org'])], relationRefs: [{ type: 'file', relation: 'owner', source: 'g' }], scopeRefs: [{ type: 'org', source: 's' }] });
      expect(model.forbidden).to.deep.equal([]);
      expect(adapter.relationCalls).to.equal(1);
    });

    it('accepts frozen inputs without mutating them', () => {
      const combine = Object.freeze({ default: Object.freeze({ algorithm: 'deny-overrides', models: Object.freeze(['rbac']) }) });
      const models = Object.freeze([new FakeModel('rbac')]);
      const refs = Object.freeze([Object.freeze({ permission: 'fs:read', type: 'file', source: 's' })]);
      passes({ combine, models, permissionRefs: refs });
    });
  });
});

function rank(rule: string): number {
  if (rule === 'combine') return 100;
  if (rule === 'routes') return 101;
  return Number(rule.slice('6.5/'.length));
}
