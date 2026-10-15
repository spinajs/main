import * as chai from 'chai';
import 'mocha';

import { validateBoot } from '../../src/engine/validate.js';
import type { BootInput } from '../../src/engine/validate.js';
import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import { AuthorizationModel, AuthzConfigError } from '../../src/contracts/index.js';
import type { ListSupport, ModelCapabilities, ModelListPlan, PermissionDef, ResourceType, Vote } from '../../src/contracts/index.js';

const expect = chai.expect;

type Route = (def: PermissionDef, type: ResourceType) => boolean;

/** Has no listSupport, so it cannot plan lists. */
class PlainModel extends AuthorizationModel {
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: [], sync: 'always', fields: false, needsSubject: false };

  constructor(readonly name: string, private readonly route: Route = () => true) {
    super();
  }

  init(): void {}

  applies(def: PermissionDef, type: ResourceType): boolean {
    return this.route(def, type);
  }

  evaluate(): Vote {
    throw new Error('evaluate must not run at boot');
  }
}

class ListingModel extends PlainModel {
  readonly asked: string[] = [];

  constructor(name: string, private readonly answer: (def: PermissionDef, type: ResourceType) => unknown = () => true, route?: Route) {
    super(name, route);
  }

  listSupport(def: PermissionDef, type: ResourceType): ListSupport {
    this.asked.push(`${def.name}@${type}`);
    return this.answer(def, type) as ListSupport;
  }

  async listPlan(): Promise<ModelListPlan> {
    throw new Error('listPlan must not run at boot');
  }
}

class SupportOnlyModel extends PlainModel {
  listSupport(): ListSupport {
    return true;
  }
}

const registry = (
  defs: { name: string; types?: string[]; list?: boolean }[] = [
    { name: 'doc:read', types: ['doc', 'folder'], list: true },
    { name: 'doc:write', types: ['doc'] },
  ],
): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(defs, 'test');
  r.freeze();
  return r;
};

const input = (over: Partial<BootInput>): BootInput => ({ domain: 'app', models: [], registry: registry(), ...over });

function lines(over: Partial<BootInput>): string[] {
  let caught: unknown;
  try {
    validateBoot(input(over));
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected validateBoot to throw').to.be.instanceOf(AuthzConfigError);
  return (caught as Error).message.split('\n').slice(1);
}

describe('validateBoot rule 12: list permissions', () => {
  it('passes when every model routed for a list permission plans it, asking about each of its types once', () => {
    const m = new ListingModel('rbac');
    expect(validateBoot(input({ models: [m] })).warnings).to.deep.equal([]);
    expect(m.asked).to.deep.equal(['doc:read@doc', 'doc:read@folder']);
  });

  it('reports a routed model without listSupport on each type', () => {
    expect(lines({ models: [new PlainModel('abac')] })).to.deep.equal(['[6.5/12] domain "app", type "doc", permission "doc:read", model "abac": cannot plan lists: it has no listSupport()', '[6.5/12] domain "app", type "folder", permission "doc:read", model "abac": cannot plan lists: it has no listSupport()']);
  });

  it('names the reason the model gives', () => {
    const m = new ListingModel('abac', (_def, type) => (type === 'doc' ? { reason: 'policy "p1" reads resource.status (authz.abac.policies)' } : true));
    expect(lines({ models: [m] })).to.deep.equal(['[6.5/12] domain "app", type "doc", permission "doc:read", model "abac": not list-filterable: policy "p1" reads resource.status (authz.abac.policies)']);
  });

  it('reports a listSupport that throws or answers neither true nor { reason }', () => {
    const boom = new ListingModel('boom', () => {
      throw new Error('store down');
    });
    const odd = new ListingModel('odd', () => false);
    const out = lines({ models: [boom, odd] });
    expect(out).to.have.length(4);
    expect(out).to.include('[6.5/12] domain "app", type "doc", permission "doc:read", model "boom": listSupport() threw: store down');
    expect(out).to.include('[6.5/12] domain "app", type "doc", permission "doc:read", model "odd": listSupport() answered "false"; expected true or { reason }');
  });

  it('reports a model that answers true but has no listPlan', () => {
    expect(lines({ models: [new SupportOnlyModel('half')] })).to.deep.equal(['[6.5/12] domain "app", type "doc", permission "doc:read", model "half": answers listSupport() true but has no listPlan()', '[6.5/12] domain "app", type "folder", permission "doc:read", model "half": answers listSupport() true but has no listPlan()']);
  });

  it('refuses another algorithm than deny-overrides on a type of a list permission', () => {
    const out = lines({ models: [new ListingModel('rbac')], combine: { default: { algorithm: 'deny-overrides' }, types: { folder: { algorithm: 'permit-overrides' } } } });
    expect(out).to.deep.equal(['[6.5/12] domain "app", type "folder", permission "doc:read": list permissions combine with deny-overrides only, got "permit-overrides"']);
  });

  it('does not ask a model the list permission is not routed to', () => {
    const narrow = new PlainModel('fs', (def) => def.name !== 'doc:read');
    expect(validateBoot(input({ models: [narrow, new ListingModel('rbac')] })).warnings).to.deep.equal([]);
  });

  it('checks nothing when no permission is list: true', () => {
    expect(validateBoot(input({ registry: registry([{ name: 'doc:write', types: ['doc'] }]), models: [new PlainModel('abac')] })).warnings).to.deep.equal([]);
  });

  it('sorts rule 12 after the other rules', () => {
    const out = lines({ models: [new PlainModel('abac')], combine: { default: { algorithm: 'deny-overrides', models: ['ghost', 'abac'] } } });
    expect(out[0]).to.match(/^\[6\.5\/1\] /);
    expect(out[out.length - 1]).to.match(/^\[6\.5\/12\] /);
  });
});
