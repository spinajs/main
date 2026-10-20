import * as chai from 'chai';
import 'mocha';

import { validateBoot } from '../../../src/engine/validate.js';
import type { BootInput } from '../../../src/engine/validate.js';
import { PermissionRegistryImpl } from '../../../src/engine/registry.js';
import { AuthorizationModel, AuthzConfigError, ResourceAdapter } from '../../../src/contracts/index.js';
import type { FilterOp, ModelCapabilities, PermissionDef, ResourceRef, ResourceType, Vote } from '../../../src/contracts/index.js';

const expect = chai.expect;

class Model extends AuthorizationModel {
  readonly capabilities: ModelCapabilities;

  constructor(readonly name: string, caps: Partial<ModelCapabilities> = {}, private readonly on: (def: PermissionDef, type: ResourceType) => boolean = () => true) {
    super();
    this.capabilities = { effects: ['permit', 'deny'], residuals: [], sync: 'always', fields: false, needsSubject: false, ...caps };
  }

  init(): void {}

  applies(def: PermissionDef, type: ResourceType): boolean {
    return this.on(def, type);
  }

  evaluate(): Vote {
    throw new Error('not at boot');
  }
}

class Adapter extends ResourceAdapter {
  constructor(readonly kind: string, readonly types: readonly ResourceType[], readonly compiles?: readonly FilterOp[]) {
    super();
  }

  accepts(_t: unknown): _t is unknown {
    return false;
  }

  refOf(): ResourceRef {
    throw new Error('not at boot');
  }

  ancestors(): Promise<null> {
    throw new Error('not at boot');
  }
}

const docOnly = (def: PermissionDef, type: ResourceType) => def.name === 'doc:edit' && type === 'doc';

const boot = (over: Partial<BootInput>): BootInput => {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:edit', types: ['doc'] }], 'test');
  registry.freeze();
  return { domain: 'cms', models: [new Model('rbac')], registry, ...over };
};

const refused = (over: Partial<BootInput>, rule: string, names: { model?: string; type?: string; permission?: string }) => {
  let caught: unknown;
  try {
    validateBoot(boot(over));
  } catch (err) {
    caught = err;
  }
  expect(caught).to.be.instanceOf(AuthzConfigError);
  const line = (caught as Error).message.split('\n').find((l) => l.startsWith(`[6.5/${rule}] `));
  expect(line, `a [6.5/${rule}] line in:\n${(caught as Error).message}`).to.be.a('string');
  expect(line).to.contain('domain "cms"');
  if (names.model) expect(line).to.contain(`model "${names.model}"`);
  if (names.type) expect(line).to.contain(`type "${names.type}"`);
  if (names.permission) expect(line).to.contain(`permission "${names.permission}"`);
};

describe('B05: boot refuses the combinations of design §6.5', () => {
  it('B05: rule 1, a combine entry lists an unregistered model', () => {
    refused({ combine: { default: { algorithm: 'deny-overrides' }, types: { doc: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] } } } }, '1', { model: 'abac', type: 'doc' });
  });

  it('B05: rule 2, two models share a name', () => {
    refused({ models: [new Model('rbac'), new Model('rbac')] }, '2', { model: 'rbac' });
  });

  it('B05: rule 3, two adapters claim one type', () => {
    refused({ adapters: [new Adapter('orm', ['doc']), new Adapter('fs', ['doc'])] }, '3', { type: 'doc' });
  });

  it('B05: rule 4, a residual op the list-scoped adapter does not compile', () => {
    refused({ models: [new Model('abac', { residuals: ['cmp', 'relation'] }, docOnly)], adapters: [new Adapter('orm', ['doc'], ['cmp'])] }, '4', { model: 'abac', type: 'doc', permission: 'doc:edit' });
  });

  it('B05: rule 4, a native op without a NativeFilter', () => {
    refused({ models: [new Model('geo', { residuals: ['native:geo'] }, docOnly)] }, '4', { model: 'geo', type: 'doc', permission: 'doc:edit' });
  });

  it('B05: rule 5, first-applicable with a model whose effects are empty', () => {
    refused({ models: [new Model('log', { effects: [] }, docOnly)], combine: { default: { algorithm: 'first-applicable' } } }, '5', { model: 'log', type: 'doc', permission: 'doc:edit' });
  });

  it('B05: rule 6, a join type routed to a sync never model', () => {
    refused({ models: [new Model('remote', { sync: 'never' }, docOnly)], joinTypes: ['doc'] }, '6', { model: 'remote', type: 'doc', permission: 'doc:edit' });
  });

  it('B05: rule 7, an unregistered permission or one checked on a foreign type', () => {
    refused({ permissionRefs: [{ permission: 'doc:publish', source: '@Access DocsController.publish' }] }, '7', { permission: 'doc:publish' });
    refused({ permissionRefs: [{ permission: 'doc:edit', type: 'page', source: 'rbac grant' }] }, '7', { permission: 'doc:edit', type: 'page' });
  });

  it('B05: rule 8, a relation without a RelationResolver', () => {
    refused({ relationRefs: [{ type: 'doc', relation: 'owner', source: 'rbac grant' }] }, '8', { type: 'doc' });
  });

  it('B05: rule 10, a scope ref to a type nothing returns as an ancestor', () => {
    refused({ scopeRefs: [{ type: 'org', source: 'abac rule' }] }, '10', { type: 'org' });
  });

  it('B05: the same config without the violations boots', () => {
    expect(validateBoot(boot({ adapters: [new Adapter('orm', ['doc'], ['cmp'])], models: [new Model('abac', { residuals: ['cmp'] })], permissionRefs: [{ permission: 'doc:edit', type: 'doc', source: 'a' }] })).warnings).to.deep.equal([]);
  });
});
