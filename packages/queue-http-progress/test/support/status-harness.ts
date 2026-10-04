import { randomUUID } from 'node:crypto';

import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/authz-queue';
import { JobModel } from '@spinajs/queue';
import { SYSTEM } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { Access, PrincipalSource } from '@spinajs/authz-http';
import { BaseController, BasePath, Controllers, Get, Param, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { hostHarness } from '@spinajs/authz-testing';
import type { BehaviourHarness, HarnessSession, HttpHandle, HttpRequest, HttpResponse } from '@spinajs/authz-testing';

import { JobsController } from '../../src/controllers/JobsControllers.js';
import { startApp, stopApp } from './app.js';
import type { TestApp } from './app.js';

const PRINCIPAL_HEADER = 'x-behaviour-principal';
const principals = new Map<string, Principal>();
let caseNo = 0;

class BehaviourPrincipalSource extends PrincipalSource {
  public readonly name = 'behaviour';
  public readonly order = 45;

  public async authenticate(req: Request): Promise<Principal | null> {
    const key = req.headers[PRINCIPAL_HEADER];
    return typeof key === 'string' ? principals.get(key) ?? null : null;
  }
}

const MIGRATION = { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: 'PerMigration' } };

/** The real JobsController re-declared under a case prefix, with its @Access bound to the test domain instead of root. */
function jobsController(prefix: string, domain: string): Class<BaseController> {
  class CaseJobs extends JobsController {
    @Get(':jobId/status')
    @Access('job:read', { domain })
    public override getStatus(@Param() jobId: string, @Req() req: Request) {
      return super.getStatus(jobId, req);
    }
  }
  Object.defineProperty(CaseJobs, 'name', { value: `CaseJobs_${prefix}` });
  BasePath(`${prefix}/jobs/v1`)(CaseJobs);
  return CaseJobs as unknown as Class<BaseController>;
}

/** hostHarness over in-memory SQLite and the real JobsController; the world's `lane.queue.records` seed the jobs table. */
export function statusHarness(): BehaviourHarness {
  const domain = 'test';
  let app: TestApp | undefined;
  let registered: Class<BaseController>[] = [];

  const unregisterCase = () => {
    for (const c of registered) {
      for (let i = 0; i < 3 && (DI.getRegisteredTypes(BaseController) ?? []).includes(c); i++) DI.unregister(c);
      DI.uncache(c);
    }
    registered = [];
    DI.uncache(BaseController);
  };

  const base = hostHarness({
    domain,
    facets: ['http', 'queue'],
    register(host) {
      host.setConfig(['authz', 'queue', 'domain'], domain);
      host.setConfig(['authz', 'orm', 'domain'], domain);
      host.setConfig(['db'], {
        DefaultConnection: 'queue',
        Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'queue', Migration: MIGRATION }],
      });
      host.setConfig(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });

      const routes = jobsController(`c${++caseNo}`, domain);
      DI.register(routes).as(BaseController);
      registered.push(routes);
    },
    async extend(host, session) {
      const prefix = `c${caseNo}`;
      const orm = await DI.resolve(Orm);
      const authz = session.authz as unknown as AuthzService;

      await authz.runAs(SYSTEM, 'status-harness seed', async () => {
        for (const r of host.world.lane?.queue?.records ?? []) {
          await JobModel.insert(
            new JobModel({
              JobId: r.id,
              Name: r.job,
              Status: r.status ?? 'created',
              Progress: 0,
              Attempt: 1,
              MaxAttempts: 1,
              Connection: 'default',
              ...(r.initiator ? { InitiatorType: r.initiator.type, InitiatorId: r.initiator.id } : {}),
            } as never),
          );
        }
      });

      const controllers = (await DI.resolve(Controllers)) as Controllers;
      for (const c of registered) await controllers.add(c);

      const http: HttpHandle = {
        async request(req: HttpRequest): Promise<HttpResponse> {
          let r = app!.request()[req.method.toLowerCase() as 'get'](`/${prefix}${req.path}`);
          if (req.principal) {
            const key = randomUUID();
            principals.set(key, req.principal);
            r = r.set(PRINCIPAL_HEADER, key);
          }
          const res = await r;
          return { status: res.status, body: res.body };
        },
        logs: () => [],
      };

      return {
        lane: { http },
        async dispose() {
          unregisterCase();
          await orm.dispose();
          DI.uncache(Orm);
        },
      } as Partial<HarnessSession>;
    },
  });

  return {
    ...base,
    async beforeAll() {
      DI.register(BehaviourPrincipalSource).as(PrincipalSource);
      app = await startApp();
      await base.beforeAll?.();
    },
    async afterAll() {
      await base.afterAll?.();
      await stopApp();
      DI.unregister(BehaviourPrincipalSource);
      DI.uncache(BehaviourPrincipalSource);
      DI.uncache(PrincipalSource);
      principals.clear();
    },
    async setup(world, ctx) {
      try {
        return await base.setup(world, ctx);
      } catch (e) {
        unregisterCase();
        throw e;
      }
    },
  };
}
