import 'mocha';
import { expect } from 'chai';
import { BaseController } from '@spinajs/http';

import { ACCESS_CLASS, Access, AllowAnonymous } from '../../src/index.js';
import { ACCESS_DESCRIPTOR } from '../../src/api.js';
import { accessDescriptorOf, ownAccessDescriptor, routeAccess } from '../../src/access/descriptor.js';
import type { IAccessDescriptor } from '../../src/access/descriptor.js';

// Controller bodies are irrelevant: only the descriptors the decorators write are read.

/** The package controller an application is meant to subclass and override. */
@Access('pkg-user:read-any')
class PkgUserController extends BaseController {
  @Access('pkg-user:update-any')
  public async update() {}

  @Access('pkg-user:read-any')
  public async list() {}
}

/** Narrows both the class rule and one inherited route: the rule is replaced, never added to (B23). */
@Access('app-user:read-own')
class AppUserController extends PkgUserController {
  @Access('app-user:update-own')
  public async update() {}
}

/** Declares no class @Access: the inherited class rule stands. */
class SilentUserController extends PkgUserController {
  @Access('silent-user:delete-own')
  public async remove() {}
}

/** Declares something about the class (anonymous access) but no permission: the inherited rule stands. */
@AllowAnonymous()
class RenamedUserController extends PkgUserController {}

/** The minimal override an application writes: subclass, register in place of the package controller, change nothing. */
class UndecoratedUserController extends PkgUserController {}

/** No ancestor and no class @Access: nothing guards the class, 3.0 has no default permission (B01). */
class StandaloneController extends BaseController {
  @Access('standalone:create')
  public async create() {}
}

class BareController extends BaseController {}

/** @Access refuses an empty list, so "grants nothing" is never declared; a later class decorator must not invent a rule either. */
@AllowAnonymous()
class AnonymousOnlyController extends BaseController {}

class BaseWithoutClassRuleController extends BaseController {
  @Access('plain:create-own')
  public async create() {}
}

class ChildOfRouteOnlyController extends BaseWithoutClassRuleController {
  @Access('plain:purge-any')
  public async purge() {}
}

@Access('named-by-child:create-any')
class NamedByChildController extends BaseWithoutClassRuleController {}

/** Three levels: the nearest ancestor's descriptor is merged, so nothing is repeated once per level. */
@Access('level-one:read-any')
class LevelOneController extends BaseController {
  @Access('level-one:update-any')
  public async update() {}
}

@AllowAnonymous()
class LevelTwoController extends LevelOneController {}

class LevelThreeController extends LevelTwoController {
  @Access('level-three:delete-own')
  public async remove() {}
}

// The 3.0 setter is ownAccessDescriptor: a declaration path outside the decorator syntax.
class ManualBaseController extends BaseController {}
ownAccessDescriptor(ManualBaseController).Access.set('save', { permissions: Object.freeze(['manual:update-any']), options: Object.freeze({}) });

class ManualDerivedController extends ManualBaseController {}
ownAccessDescriptor(ManualDerivedController).Anonymous.set(ACCESS_CLASS, true);

/** Own metadata only: Reflect.getMetadata walks the prototype chain and reports the parent's descriptor for a class that owns none. */
const ownDescriptorOf = (c: { prototype: object }) => Reflect.getOwnMetadata(ACCESS_DESCRIPTOR, c.prototype) as IAccessDescriptor | undefined;

const descriptorOf = (c: object) => accessDescriptorOf(c)!;

const rule = (d: IAccessDescriptor, key: string | symbol) => d.Access.get(key)?.permissions;

const routeKeys = (d: IAccessDescriptor) => [...d.Access.keys()].filter((k): k is string => typeof k === 'string').sort();

describe('access descriptor inheritance', () => {
  it('leaves the package controller descriptor untouched', () => {
    const pkg = descriptorOf(PkgUserController);

    expect(rule(pkg, ACCESS_CLASS), 'subclass rewrote the package controller class rule').to.deep.eq(['pkg-user:read-any']);
    expect(routeKeys(pkg), 'subclass leaked a route into the package controller').to.deep.eq(['list', 'update']);
    expect(rule(pkg, 'update'), 'subclass rewrote the package route rule').to.deep.eq(['pkg-user:update-any']);
    expect(pkg.Anonymous.size, 'subclass leaked anonymous access into the package controller').to.eq(0);
  });

  it('gives the subclass a descriptor object of its own', () => {
    const pkg = ownDescriptorOf(PkgUserController)!;

    expect(ownDescriptorOf(AppUserController), 'subclass owns no descriptor of its own').to.exist;
    expect(ownDescriptorOf(AppUserController)).to.not.equal(pkg);
    expect(ownDescriptorOf(SilentUserController)).to.not.equal(pkg);
    expect(ownDescriptorOf(AppUserController)!.Access).to.not.equal(pkg.Access);
  });

  it('inherits the class rule when the subclass declares none', () => {
    expect(rule(descriptorOf(SilentUserController), ACCESS_CLASS)).to.deep.eq(['pkg-user:read-any']);
  });

  it('replaces the inherited class rule instead of concatenating it', () => {
    // Concatenating would give both permissions and defeat the application's attempt to NARROW the controller.
    expect(rule(descriptorOf(AppUserController), ACCESS_CLASS)).to.deep.eq(['app-user:read-own']);
  });

  it('keeps the inherited class rule for a subclass that declares no @Access', () => {
    expect(descriptorOf(SilentUserController).Access.get(ACCESS_CLASS)).to.equal(descriptorOf(PkgUserController).Access.get(ACCESS_CLASS));
  });

  it('inherits the class rule when the subclass declares anonymous access but no permission', () => {
    const renamed = descriptorOf(RenamedUserController);

    expect(renamed.Anonymous.has(ACCESS_CLASS)).to.eq(true);
    expect(descriptorOf(PkgUserController).Anonymous.has(ACCESS_CLASS), 'anonymous access leaked into the base').to.eq(false);
    expect(rule(renamed, ACCESS_CLASS)).to.deep.eq(['pkg-user:read-any']);
    expect(rule(renamed, 'update')).to.deep.eq(['pkg-user:update-any']);
  });

  it('has no default permission: a class that declares no @Access has no rule', () => {
    // 2.x filled in readOwn; 3.0 has none (B01: nothing routed permits => no_access), so a missing rule stays missing.
    const standalone = descriptorOf(StandaloneController);

    expect(standalone.Access.has(ACCESS_CLASS)).to.eq(false);
    expect(rule(standalone, 'create')).to.deep.eq(['standalone:create']);

    expect(accessDescriptorOf(BareController), 'a class without any 3.0 decorator owns no descriptor').to.eq(undefined);
    expect(routeAccess(new BareController(), 'anything')).to.deep.eq({ anonymous: false });
  });

  it('cannot declare an empty permission list, and no later decorator invents a rule', () => {
    expect(() => Access([])).to.throw(/at least one permission/);
    expect(descriptorOf(AnonymousOnlyController).Access.size).to.eq(0);
    expect(descriptorOf(AnonymousOnlyController).Anonymous.has(ACCESS_CLASS)).to.eq(true);
  });

  it('inherits the absence of a class rule: the subclass ends with no more than its base', () => {
    const child = descriptorOf(ChildOfRouteOnlyController);

    expect(child.Access.has(ACCESS_CLASS)).to.eq(false);
    expect(routeKeys(child)).to.deep.eq(['create', 'purge']);
    expect(rule(child, 'purge')).to.deep.eq(['plain:purge-any']);
    expect(routeKeys(descriptorOf(BaseWithoutClassRuleController)), 'child route leaked into the base').to.deep.eq(['create']);
  });

  it('resolves reads to the parent for a subclass with no access decorators', () => {
    expect(ownDescriptorOf(UndecoratedUserController), 'an undecorated subclass must not own a descriptor').to.not.exist;

    const undecorated = descriptorOf(UndecoratedUserController);

    expect(undecorated).to.equal(ownDescriptorOf(PkgUserController));
    expect(rule(undecorated, ACCESS_CLASS)).to.deep.eq(['pkg-user:read-any']);
    expect(rule(undecorated, 'update')).to.deep.eq(['pkg-user:update-any']);

    // The same holds for an instance, which is what AccessPolicy reads.
    expect(accessDescriptorOf(new UndecoratedUserController())).to.equal(undecorated);
  });

  it('lets a subclass add the class rule its base left undeclared', () => {
    const base = descriptorOf(BaseWithoutClassRuleController);
    const child = descriptorOf(NamedByChildController);

    expect(base.Access.has(ACCESS_CLASS), 'child class rule leaked into the base').to.eq(false);

    expect(rule(child, ACCESS_CLASS)).to.deep.eq(['named-by-child:create-any']);
    expect(rule(child, 'create')).to.deep.eq(['plain:create-own']);
  });

  it('does not accumulate down a three level chain', () => {
    const three = descriptorOf(LevelThreeController);

    expect(rule(three, ACCESS_CLASS)).to.deep.eq(['level-one:read-any']);
    expect(routeKeys(three)).to.deep.eq(['remove', 'update']);
    expect(rule(three, 'update')).to.deep.eq(['level-one:update-any']);
    expect(three.Access.size).to.eq(3);
    expect(three.Anonymous.has(ACCESS_CLASS)).to.eq(true);
  });

  it('inherits through ownAccessDescriptor as well', () => {
    // setRbacMetadata has no 3.0 counterpart; ownAccessDescriptor is the one setter, and the copy semantics stay.
    const base = descriptorOf(ManualBaseController);
    const derived = descriptorOf(ManualDerivedController);

    expect(derived).to.not.equal(base);
    expect(base.Anonymous.size, 'derived class wrote through to the base').to.eq(0);

    expect(derived.Anonymous.has(ACCESS_CLASS)).to.eq(true);
    expect(rule(derived, 'save')).to.deep.eq(['manual:update-any']);
  });

  it('replaces an inherited route entry the subclass redeclares', () => {
    expect(rule(descriptorOf(AppUserController), 'update')).to.deep.eq(['app-user:update-own']);
    expect(rule(descriptorOf(PkgUserController), 'update')).to.deep.eq(['pkg-user:update-any']);
  });

  it('inherits routes the subclass does not redeclare', () => {
    const app = descriptorOf(AppUserController);

    expect(routeKeys(app)).to.deep.eq(['list', 'update']);
    expect(rule(app, 'list')).to.deep.eq(['pkg-user:read-any']);
    expect(rule(descriptorOf(SilentUserController), 'remove')).to.deep.eq(['silent-user:delete-own']);
  });

  it('keeps resolving the descriptor from a controller instance', () => {
    // AccessPolicy reads it off the controller instance, so a descriptor stored on the prototype must stay reachable.
    const instance = new AppUserController();
    const descriptor = Reflect.getMetadata(ACCESS_DESCRIPTOR, instance) as IAccessDescriptor;
    const access = routeAccess(instance, 'update');

    expect(rule(descriptor, ACCESS_CLASS)).to.deep.eq(['app-user:read-own']);
    expect(access.route?.permissions).to.deep.eq(['app-user:update-own']);
    expect(access.controller?.permissions).to.deep.eq(['app-user:read-own']);
    expect(routeAccess(instance, 'list').route?.permissions).to.deep.eq(['pkg-user:read-any']);
  });
});
