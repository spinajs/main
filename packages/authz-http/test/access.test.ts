import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { AuthzConfigError, authzStorage } from '@spinajs/authz';
import type { DecisionRequest } from '@spinajs/authz';
import { BaseController, BasePath, BasePolicy, CONTROLLED_DESCRIPTOR_SYMBOL, Get, Ok, Policy, Req } from '@spinajs/http';
import type { IControllerDescriptor, Request } from '@spinajs/http';
import { Forbidden } from '@spinajs/exceptions';
import { testHost } from '@spinajs/authz-testing';
import type { ScriptedVote } from '@spinajs/authz-testing';

import { ACCESS_CLASS, ACCESS_DESCRIPTOR, Access, AccessContributor, AccessPolicy, AllowAnonymous, Unscoped, accessDescriptorOf, typedExtractor } from '../src/index.js';
import type { IAccessDescriptor } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { createDomain } from './support/domain.js';
import type { TestDomain } from './support/domain.js';
import { registerHeaderSource } from './support/principals.js';

const D = 'acc';
const PERMISSIONS = { 'file:read': {}, 'file:update': {}, 'file:write': {} };

class AlsoFails extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public async execute() {
    throw new Forbidden('also failed');
  }
}

class OtherPasses extends BasePolicy {
  public isEnabled() {
    return true;
  }
  public async execute() {}
}

const answer = (req: Request) => new Ok({ permission: req.storage.AuthzDecision?.permission ?? null, unscoped: authzStorage().getStore()?.Unscoped ?? null });

@BasePath('acc')
class AccessRoutes extends BaseController {
  @Get('files/:id')
  @Access('file:read', { domain: D, resource: (req) => ({ type: 'file', id: req.params.id }) })
  public file(@Req() req: Request) {
    return answer(req);
  }

  @Get('any')
  @Access(['file:update', 'file:read'], { domain: D })
  public any(@Req() req: Request) {
    return answer(req);
  }

  @Get('also')
  @Access('file:read', { domain: D, also: [AlsoFails] })
  public also(@Req() req: Request) {
    return answer(req);
  }

  @Get('alternative')
  @Access('file:write', { domain: D })
  @Policy(OtherPasses)
  public alternative(@Req() req: Request) {
    return answer(req);
  }

  @Get('public')
  @AllowAnonymous()
  @Access('file:read', { domain: D })
  public open(@Req() req: Request) {
    return answer(req);
  }

  @Get('reports')
  @Access('file:read', { domain: D })
  @Unscoped('report export')
  public reports(@Req() req: Request) {
    return answer(req);
  }

  @Get('denied-reports')
  @Access('file:update', { domain: D })
  @Unscoped('never reached')
  public deniedReports(@Req() req: Request) {
    return answer(req);
  }
}

@BasePath('acc-class')
@Access('file:read', { domain: D })
class ClassAccess extends BaseController {
  @Get('a')
  public a(@Req() req: Request) {
    return answer(req);
  }

  @Get('b')
  @Access('file:update', { domain: D })
  public b(@Req() req: Request) {
    return answer(req);
  }
}

class ClassAccessChild extends ClassAccess {}

// Permits file:read to alice and to anonymous principals; nothing else.
const votes = (req: DecisionRequest): ScriptedVote => (req.permission === 'file:read' && (req.principal.id === 'alice' || req.principal.type === 'anonymous') ? { permitWhen: { op: 'true' } } : {});

describe('@Access, @AllowAnonymous, @Unscoped', function () {
  this.timeout(30000);

  let app: TestApp;
  let domain: TestDomain;
  let unregisterSource: () => void;

  before(async () => {
    unregisterSource = registerHeaderSource();
    app = await startApp({ controllers: [AccessRoutes, ClassAccess] });
    domain = await createDomain(D, { permissions: PERMISSIONS, model: { votes } });
  });

  after(async () => {
    await domain?.dispose();
    await stopApp();
    unregisterSource();
  });

  beforeEach(() => {
    domain.model.calls.length = 0;
    domain.audit.entries.length = 0;
  });

  describe('metadata', () => {
    it('records each @Access under ACCESS_DESCRIPTOR on the prototype, the class one under ACCESS_CLASS', () => {
      const d = Reflect.getMetadata(ACCESS_DESCRIPTOR, AccessRoutes.prototype) as IAccessDescriptor;
      expect(d.Access.get('any')).to.deep.include({ permissions: ['file:update', 'file:read'] });
      expect(d.Access.get('any')!.options).to.deep.eq({ domain: D });
      expect(d.Anonymous.has('open')).to.eq(true);
      expect(d.Unscoped.get('reports')).to.eq('report export');
      expect(accessDescriptorOf(ClassAccess)!.Access.get(ACCESS_CLASS)!.permissions).to.deep.eq(['file:read']);
    });

    it('a subclass inherits the declarations in a copy of its own', () => {
      @Access('file:write', { domain: D })
      class Narrowed extends ClassAccess {}

      expect(accessDescriptorOf(ClassAccessChild)!.Access.get('b')!.permissions).to.deep.eq(['file:update']);
      expect(accessDescriptorOf(Narrowed)!.Access.get(ACCESS_CLASS)!.permissions).to.deep.eq(['file:write']);
      expect(accessDescriptorOf(ClassAccess)!.Access.get(ACCESS_CLASS)!.permissions).to.deep.eq(['file:read']);
    });

    it('places AccessPolicy and the `also` policies in one policy group (AND)', () => {
      const http = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AccessRoutes.prototype) as IControllerDescriptor;
      const groups = http.Routes.get('also')!.Policies;

      expect(groups).to.have.length(1);
      expect(groups[0].map((p) => p.Type)).to.deep.eq([AccessPolicy, AlsoFails]);
      expect(groups[0][1].Options).to.deep.eq([]);
      expect(http.Routes.get('alternative')!.Policies.map((g) => g.map((p) => p.Type))).to.deep.eq([[OtherPasses], [AccessPolicy]]);
      expect((Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, ClassAccess.prototype) as IControllerDescriptor).Policies[0][0].Type).to.eq(AccessPolicy);
    });

    it('refuses an empty permission list, a malformed permission and an empty reason when the module loads', () => {
      expect(() => Access([])).to.throw(/at least one permission/);
      expect(() => Access('not a permission')).to.throw();
      expect(() => Unscoped(' ')).to.throw(/reason/);
    });
  });

  describe('requests', () => {
    it('allows a permitted request and leaves the decision in req.storage.AuthzDecision', async () => {
      const res = await app.request().get('/acc/files/f1').set('x-user', 'alice');

      expect(res.status).to.eq(200);
      expect(res.body.permission).to.eq('file:read');
      expect(domain.model.requests[0].resource).to.deep.eq({ type: 'file', id: 'f1' });
    });

    it('refuses a denied request with 403', async () => {
      const res = await app.request().get('/acc/files/f1').set('x-user', 'bob');

      expect(res.status).to.eq(403);
    });

    it('checks the type-level ref of the permission resource without a resource extractor', async () => {
      await app.request().get('/acc/any').set('x-user', 'alice');

      expect(domain.model.requests.map((r) => r.resource)).to.deep.include({ type: 'file' });
    });

    it('several permissions mean any of them', async () => {
      const res = await app.request().get('/acc/any').set('x-user', 'alice');

      expect(res.status).to.eq(200);
      expect(res.body.permission).to.eq('file:read');
    });

    it('an `also` policy that fails refuses the route although the permission is granted', async () => {
      const res = await app.request().get('/acc/also').set('x-user', 'alice');

      expect(res.status).to.eq(403);
    });

    it('a separate @Policy group stays an alternative (OR) to the @Access group', async () => {
      const res = await app.request().get('/acc/alternative').set('x-user', 'bob');

      expect(res.status).to.eq(200);
    });

    it('an anonymous request to an @Access route without @AllowAnonymous is 401 before any model runs', async () => {
      const res = await app.request().get('/acc/files/f1');

      expect(res.status).to.eq(401);
      expect(domain.model.calls.filter((c) => c.method === 'evaluate')).to.have.length(0);
    });

    it('an anonymous request to an @AllowAnonymous route reaches the models', async () => {
      const res = await app.request().get('/acc/public');

      expect(res.status).to.eq(200);
      expect(domain.model.requests[0].principal.type).to.eq('anonymous');
    });

    it('without any principal even an @AllowAnonymous route is 401', async () => {
      testHost.config().set(['authz', 'principals', 'anonymous', 'enabled'], false);
      try {
        const res = await app.request().get('/acc/public');
        expect(res.status).to.eq(401);
      } finally {
        testHost.config().unset(['authz', 'principals', 'anonymous', 'enabled']);
      }
    });

    it('a class-level @Access guards every route, and a route @Access narrows it (AND)', async () => {
      expect((await app.request().get('/acc-class/a').set('x-user', 'alice')).status).to.eq(200);
      expect((await app.request().get('/acc-class/a').set('x-user', 'bob')).status).to.eq(403);
      expect((await app.request().get('/acc-class/b').set('x-user', 'alice')).status).to.eq(403);
    });
  });

  describe('@Unscoped', () => {
    it('sets Unscoped in the store the action runs with and audits the bypass with its reason', async () => {
      const res = await app.request().get('/acc/reports').set('x-user', 'alice');

      expect(res.status).to.eq(200);
      expect(res.body.unscoped).to.eq('report export');
      expect(domain.audit.of('unscoped')).to.deep.eq([{ kind: 'unscoped', principal: { type: 'user', id: 'alice' }, reason: 'report export' }]);
    });

    it('other routes run scoped', async () => {
      const res = await app.request().get('/acc/files/f1').set('x-user', 'alice');

      expect(res.body.unscoped).to.eq(null);
    });

    it('a refused request is no bypass: nothing is audited', async () => {
      const res = await app.request().get('/acc/denied-reports').set('x-user', 'alice');

      expect(res.status).to.eq(403);
      expect(domain.audit.of('unscoped')).to.deep.eq([]);
    });

    it('is not audited while the domain turns audit.unscoped off', async () => {
      testHost.config().set(['authz', 'domains', D, 'audit'], { unscoped: false });
      try {
        await app.request().get('/acc/reports').set('x-user', 'alice');
        expect(domain.audit.of('unscoped')).to.deep.eq([]);
      } finally {
        testHost.config().unset(['authz', 'domains', D, 'audit']);
      }
    });
  });

  describe('boot refs (AccessContributor)', () => {
    it("contributes the permissions of the domain's routes, with the extractor's type", () => {
      const refs = new AccessContributor().contribute(D).permissionRefs!;

      expect(refs).to.deep.include({ permission: 'file:read', source: '@Access on AccessRoutes.file' });
      expect(refs).to.deep.include({ permission: 'file:read', source: '@Access on ClassAccess' });
      expect(new AccessContributor().contribute('elsewhere').permissionRefs).to.deep.eq([]);
    });

    it('fails the boot of a domain whose routes name an unregistered permission, or one on a type outside its types', async () => {
      @BasePath('ghost')
      class GhostRoutes extends BaseController {
        @Get()
        @Access('ghost:read', { domain: 'acc-ghost' })
        public ghost() {
          return new Ok();
        }

        @Get('typed')
        @Access('file:read', { domain: 'acc-ghost', resource: typedExtractor('project', () => ({ type: 'project' })) })
        public typed() {
          return new Ok();
        }
      }

      DI.register(GhostRoutes).as(BaseController);
      try {
        const err = await createDomain('acc-ghost', { permissions: { 'file:read': { types: ['file'] } } }).then(
          (d) => d.dispose().then(() => null),
          (e: unknown) => e,
        );
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.contain('ghost:read').and.contain('project');
      } finally {
        DI.unregister(GhostRoutes);
        DI.uncache(GhostRoutes);
      }
    });
  });
});
