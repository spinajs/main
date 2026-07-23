import 'mocha';
import { expect } from 'chai';
import { PermissionType } from '@spinajs/rbac';
import { ACL_CONTROLLER_DESCRIPTOR, Permission, Resource, setRbacMetadata } from '../src/decorators.js';
import { IRbacDescriptor } from '../src/interfaces.js';

/**
 * Package controller - the one an application is meant to subclass and override
 * ( eg. `UserController` from @spinajs/rbac-http-user ).
 */
@Resource('pkg-user', ['readAny'])
class PkgUserController {
  @Permission(['updateAny'])
  public async update() {
    /* route body is irrelevant here - only its ACL metadata is */
  }

  @Permission(['readAny'])
  public async list() {
    /* see above */
  }
}

/**
 * Application controller narrowing both the controller wide permission and one
 * inherited route. Narrowing is the point: a longer permission list GRANTS MORE.
 */
@Resource('app-user', ['readOwn'])
class AppUserController extends PkgUserController {
  @Permission(['updateOwn'])
  public async update() {
    /* see above */
  }
}

/**
 * Subclass that declares no @Resource at all - it must inherit both the
 * resource and the permission rather than fall back to the bare defaults.
 */
class SilentUserController extends PkgUserController {
  @Permission(['deleteOwn'])
  public async remove() {
    /* see above */
  }
}

/**
 * Subclass renaming the resource and passing NO permission argument. The
 * argument has a default value, but omitting it means "say nothing about
 * permissions", not "reset them to readOwn" - the base controller's list stands.
 */
@Resource('renamed-user')
class RenamedUserController extends PkgUserController {}

/**
 * The minimal override shape an application actually writes: subclass, register
 * it in place of the package controller, change nothing about the ACL. It owns
 * no metadata of its own and every read has to resolve to the parent's.
 */
class UndecoratedUserController extends PkgUserController {}

/**
 * No ancestor, no @Resource - documents the fallback permission of a controller
 * that only uses route level @Permission.
 */
class StandaloneController {
  @Permission(['createAny'])
  public async create() {
    /* see above */
  }
}

/**
 * No ancestor, @Resource without a permission argument - the documented default
 * has to come from somewhere now that the argument no longer carries it.
 */
@Resource('root-only')
class RootResourceController {}

/**
 * Deliberately empty permission list, with a second class level decorator after
 * it. Class decorators apply bottom-up, so `@Permission` touches the descriptor
 * once `@Resource` has already emptied it.
 */
@Permission(['updateAny'])
@Resource('emptied', [])
class EmptiedPermissionController {}

/**
 * Subclass of a base that granted nothing. An empty list is a declaration, so
 * inheriting it must not be confused with having nothing to inherit - the
 * subclass may not end up with more than its base.
 */
class ChildOfEmptiedController extends EmptiedPermissionController {
  @Permission(['deleteAny'])
  public async purge() {
    /* see above */
  }
}

/**
 * Base declaring route permissions but no @Resource, subclassed by a class that
 * declares one. Exercises the empty-string resource and the default permission
 * being inherited and then overridden.
 */
class BaseWithoutResourceController {
  @Permission(['createOwn'])
  public async create() {
    /* see above */
  }
}

@Resource('named-by-child', ['createAny'])
class NamedByChildController extends BaseWithoutResourceController {}

/**
 * Three levels. Only the NEAREST ancestor's descriptor may be merged: every
 * stored descriptor is already collapsed, so folding the whole chain in would
 * duplicate array elements once per level.
 */
@Resource('level-one', ['readAny'])
class LevelOneController {
  @Permission(['updateAny'])
  public async update() {
    /* see above */
  }
}

@Resource('level-two')
class LevelTwoController extends LevelOneController {}

class LevelThreeController extends LevelTwoController {
  @Permission(['deleteOwn'])
  public async remove() {
    /* see above */
  }
}

/**
 * `setRbacMetadata` is exported public API with no caller in this repository,
 * so nothing else would notice if it stopped inheriting. Called here the way a
 * consumer would - on the class, outside the decorator syntax.
 */
class ManualBaseController {}
setRbacMetadata(ManualBaseController, (meta) => {
  meta.Resource = 'manual-base';
  meta.Permission = ['updateAny'];
  meta.Routes.set('save', { Permission: ['updateAny'] });
});

class ManualDerivedController extends ManualBaseController {}
setRbacMetadata(ManualDerivedController, (meta) => {
  meta.Resource = 'manual-derived';
});

/**
 * Own metadata only. `Reflect.getMetadata` walks the prototype chain and would
 * report the parent's descriptor for a class that owns none, which is exactly
 * the confusion these tests exist to rule out.
 */
const ownDescriptorOf = (c: object) => Reflect.getOwnMetadata(ACL_CONTROLLER_DESCRIPTOR, c) as IRbacDescriptor;

/**
 * How the real consumers read it - RbacPolicy off the request's controller
 * instance, http-swagger off the resolved controller instance. Both walk the
 * prototype chain, so this must keep resolving to the class's own descriptor.
 */
const descriptorOf = (c: object) => Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, c) as IRbacDescriptor;

const permissionsOf = (d: IRbacDescriptor, route: string) => d.Routes.get(route)?.Permission;

describe('rbac controller descriptor inheritance', () => {
  it('leaves the package controller descriptor untouched', () => {
    const pkg = descriptorOf(PkgUserController.prototype);

    expect(pkg.Resource, 'subclass rewrote the package controller resource').to.eq('pkg-user');
    expect(pkg.Permission, 'subclass rewrote the package controller permission').to.deep.eq(['readAny']);
    expect([...pkg.Routes.keys()].sort(), 'subclass leaked a route into the package controller').to.deep.eq(['list', 'update']);
    expect(permissionsOf(pkg, 'update'), 'subclass rewrote the package route permission').to.deep.eq(['updateAny']);
  });

  it('gives the subclass a descriptor object of its own', () => {
    expect(ownDescriptorOf(AppUserController.prototype), 'subclass owns no descriptor of its own').to.exist;
    expect(ownDescriptorOf(AppUserController.prototype)).to.not.equal(ownDescriptorOf(PkgUserController.prototype));
    expect(ownDescriptorOf(SilentUserController.prototype)).to.not.equal(ownDescriptorOf(PkgUserController.prototype));
  });

  it('inherits Resource when the subclass declares none', () => {
    expect(descriptorOf(SilentUserController.prototype).Resource).to.eq('pkg-user');
  });

  it('replaces the inherited Permission instead of concatenating it', () => {
    // Concatenating would yield ['readAny', 'readOwn'] and defeat the
    // application's attempt to NARROW what the controller grants.
    expect(descriptorOf(AppUserController.prototype).Permission).to.deep.eq(['readOwn']);
  });

  it('inherits Permission when the subclass declares none', () => {
    expect(descriptorOf(SilentUserController.prototype).Permission).to.deep.eq(['readAny']);
  });

  it('inherits Permission when the subclass declares a Resource but no permission', () => {
    // `@Resource(resource)` omits an argument that has a default value. Taking
    // that default as a declaration would silently reset an inherited
    // ['readAny'] to ['readOwn'] just because the subclass renamed the resource.
    const renamed = descriptorOf(RenamedUserController.prototype);

    expect(renamed.Resource).to.eq('renamed-user');
    expect(renamed.Permission).to.deep.eq(['readAny']);
    expect(permissionsOf(renamed, 'update')).to.deep.eq(['updateAny']);
  });

  it('falls back to the default permission with nothing to inherit', () => {
    expect(descriptorOf(StandaloneController.prototype).Permission).to.deep.eq(['readOwn']);
    expect(permissionsOf(descriptorOf(StandaloneController.prototype), 'create')).to.deep.eq(['createAny']);

    // Same default, reached through @Resource rather than through a route.
    expect(descriptorOf(RootResourceController.prototype).Permission).to.deep.eq(['readOwn']);
    expect(descriptorOf(RootResourceController.prototype).Resource).to.eq('root-only');
  });

  it('does not refill a permission list the class emptied on purpose', () => {
    // The default is applied when the descriptor is CREATED. Applying it on
    // every decorator would let a later decorator resurrect ['readOwn'] on a
    // class that explicitly declared it grants nothing.
    expect(descriptorOf(EmptiedPermissionController.prototype).Permission).to.deep.eq([]);
  });

  it('inherits a deliberately empty permission list', () => {
    // The default may only stand in when there is NO ancestor descriptor at all.
    // Deciding on "the collapsed list came out empty" instead would hand this
    // subclass readOwn - more than its base grants, and the one direction a
    // permission list must never drift in.
    const child = descriptorOf(ChildOfEmptiedController.prototype);

    expect(child.Permission).to.deep.eq([]);
    expect(child.Resource).to.eq('emptied');
    expect(permissionsOf(child, 'purge')).to.deep.eq(['deleteAny']);
  });

  it('resolves reads to the parent for a subclass with no rbac decorators', () => {
    // Task 5's minimal override: subclass, register it in place of the package
    // controller, declare nothing. No decorator runs, so no own metadata is
    // created and every read has to fall through to the parent's descriptor.
    expect(ownDescriptorOf(UndecoratedUserController.prototype), 'an undecorated subclass must not own metadata').to.not.exist;

    const undecorated = descriptorOf(UndecoratedUserController.prototype);

    expect(undecorated).to.equal(ownDescriptorOf(PkgUserController.prototype));
    expect(undecorated.Resource).to.eq('pkg-user');
    expect(undecorated.Permission).to.deep.eq(['readAny']);
    expect(permissionsOf(undecorated, 'update')).to.deep.eq(['updateAny']);

    // ...and the same holds for an instance of it, which is what RbacPolicy sees.
    expect(Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, new UndecoratedUserController())).to.equal(undecorated);
  });

  it('lets a subclass name the resource its base left undeclared', () => {
    const base = descriptorOf(BaseWithoutResourceController.prototype);
    const child = descriptorOf(NamedByChildController.prototype);

    expect(base.Resource, 'child resource leaked into the base').to.eq('');
    expect(base.Permission).to.deep.eq(['readOwn']);

    expect(child.Resource).to.eq('named-by-child');
    expect(child.Permission).to.deep.eq(['createAny']);
    expect(permissionsOf(child, 'create')).to.deep.eq(['createOwn']);
  });

  it('does not accumulate down a three level chain', () => {
    // Every stored descriptor is already collapsed, so merging the whole chain
    // instead of the nearest ancestor would duplicate array elements per level
    // ( eg. ['readAny', 'readAny'] ) - and a longer permission list grants more.
    const three = descriptorOf(LevelThreeController.prototype);

    expect(three.Resource).to.eq('level-two');
    expect(three.Permission).to.deep.eq(['readAny']);
    expect([...three.Routes.keys()].sort()).to.deep.eq(['remove', 'update']);
    expect(permissionsOf(three, 'update')).to.deep.eq(['updateAny']);
  });

  it('inherits through setRbacMetadata as well', () => {
    const base = descriptorOf(ManualBaseController.prototype);
    const derived = descriptorOf(ManualDerivedController.prototype);

    expect(derived).to.not.equal(base);
    expect(base.Resource, 'derived class rewrote the base resource').to.eq('manual-base');

    expect(derived.Resource).to.eq('manual-derived');
    expect(derived.Permission).to.deep.eq(['updateAny']);
    expect(permissionsOf(derived, 'save')).to.deep.eq(['updateAny']);
  });

  it('replaces an inherited route entry the subclass redeclares', () => {
    expect(permissionsOf(descriptorOf(AppUserController.prototype), 'update')).to.deep.eq(['updateOwn']);
  });

  it('inherits routes the subclass does not redeclare', () => {
    const app = descriptorOf(AppUserController.prototype);

    expect([...app.Routes.keys()].sort()).to.deep.eq(['list', 'update']);
    expect(permissionsOf(app, 'list')).to.deep.eq(['readAny']);
    expect(permissionsOf(descriptorOf(SilentUserController.prototype), 'remove')).to.deep.eq(['deleteOwn']);
  });

  it('keeps resolving the descriptor from a controller instance', () => {
    // RbacPolicy.execute reads it off the instance, so an own descriptor stored
    // on the prototype must still be reachable from there.
    const descriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, new AppUserController()) as IRbacDescriptor;

    expect(descriptor.Resource).to.eq('app-user');
    expect(descriptor.Permission).to.deep.eq(['readOwn'] as PermissionType[]);
    expect(permissionsOf(descriptor, 'update')).to.deep.eq(['updateOwn']);
    expect(permissionsOf(descriptor, 'list')).to.deep.eq(['readAny']);
  });
});
