import 'mocha';
import { expect } from 'chai';
import { PermissionType } from '@spinajs/rbac';
import { ACL_CONTROLLER_DESCRIPTOR, Permission, Resource } from '../src/decorators.js';
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

  it('falls back to the default permission with nothing to inherit', () => {
    expect(descriptorOf(StandaloneController.prototype).Permission).to.deep.eq(['readOwn']);
    expect(permissionsOf(descriptorOf(StandaloneController.prototype), 'create')).to.deep.eq(['createAny']);
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
