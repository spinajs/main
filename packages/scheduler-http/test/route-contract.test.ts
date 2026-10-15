import 'mocha';
import { expect } from 'chai';
import { CONTROLLED_DESCRIPTOR_SYMBOL, IControllerDescriptor, RouteType } from '@spinajs/http';
import { ACL_CONTROLLER_DESCRIPTOR, AuthorizedPolicy, IRbacDescriptor } from '@spinajs/rbac-http';

import { ErrorsController } from '../src/controllers/ErrorsController.js';
import { MaintenanceController } from '../src/controllers/MaintenanceController.js';
import { RunsController } from '../src/controllers/RunsController.js';
import { SchedulesController } from '../src/controllers/SchedulesController.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RUN } from '../src/permissions.js';

const CONTROLLERS = { SchedulesController, RunsController, ErrorsController, MaintenanceController };

const BASE_PATHS: Record<keyof typeof CONTROLLERS, string> = {
  SchedulesController: 'scheduler/schedules',
  RunsController: 'scheduler/runs',
  ErrorsController: 'scheduler/errors',
  MaintenanceController: 'scheduler',
};

// design §7, one row per endpoint
const ROUTES: Record<string, { type: RouteType; path: string; permission: string[] }> = {
  'SchedulesController.list': { type: RouteType.GET, path: '/', permission: SCHEDULER_READ },
  'SchedulesController.show': { type: RouteType.GET, path: ':name', permission: SCHEDULER_READ },
  'SchedulesController.runNow': { type: RouteType.POST, path: ':name/runs', permission: SCHEDULER_RUN },
  'SchedulesController.retryFailed': { type: RouteType.POST, path: ':name/retry-failed', permission: SCHEDULER_RUN },
  'SchedulesController.pause': { type: RouteType.POST, path: ':name/pause', permission: SCHEDULER_MANAGE },
  'SchedulesController.resume': { type: RouteType.POST, path: ':name/resume', permission: SCHEDULER_MANAGE },
  'SchedulesController.events': { type: RouteType.GET, path: ':name/events', permission: SCHEDULER_READ },
  'RunsController.list': { type: RouteType.GET, path: '/', permission: SCHEDULER_READ },
  'RunsController.show': { type: RouteType.GET, path: ':id', permission: SCHEDULER_READ },
  'RunsController.events': { type: RouteType.GET, path: ':id/events', permission: SCHEDULER_READ },
  'RunsController.cancel': { type: RouteType.POST, path: ':id/cancel', permission: SCHEDULER_RUN },
  'RunsController.retry': { type: RouteType.POST, path: ':id/retry', permission: SCHEDULER_RUN },
  'ErrorsController.list': { type: RouteType.GET, path: '/', permission: SCHEDULER_READ },
  'ErrorsController.setStatus': { type: RouteType.PATCH, path: ':fingerprint', permission: SCHEDULER_MANAGE },
  'MaintenanceController.prune': { type: RouteType.POST, path: 'prune', permission: SCHEDULER_MANAGE },
};

const http = (c: { prototype: object }) => Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, c.prototype) as IControllerDescriptor;
const acl = (c: { prototype: object }) => Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, c.prototype) as IRbacDescriptor;

describe('scheduler-http route contract', () => {
  it('exposes exactly the design §7 endpoints', () => {
    const actual: string[] = [];
    for (const [name, controller] of Object.entries(CONTROLLERS)) {
      for (const route of http(controller).Routes.values()) {
        actual.push(`${name}.${String(route.Method)}`);
      }
    }

    expect(actual.sort()).to.deep.equal(Object.keys(ROUTES).sort());
  });

  it('mounts every controller at its base path behind AuthorizedPolicy on the scheduler resource', () => {
    for (const [name, controller] of Object.entries(CONTROLLERS)) {
      const descriptor = http(controller);

      expect(descriptor.BasePath, name).to.eq(BASE_PATHS[name as keyof typeof CONTROLLERS]);
      expect(descriptor.Policies.flat().map((p) => p.Type), name).to.include(AuthorizedPolicy);
      expect(acl(controller).Resource, name).to.eq('scheduler');
    }
  });

  for (const [key, expected] of Object.entries(ROUTES)) {
    it(`${key} is ${expected.type.toUpperCase()} ${expected.path} with ${expected.permission}`, () => {
      const [name, method] = key.split('.');
      const controller = CONTROLLERS[name as keyof typeof CONTROLLERS];
      const route = http(controller).Routes.get(method)!;

      expect(route.Type).to.eq(expected.type);
      expect(route.Path).to.eq(expected.path);
      expect(acl(controller).Routes.get(method)?.Permission).to.deep.equal(expected.permission);
    });
  }
});
