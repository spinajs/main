import * as chai from 'chai';
import 'mocha';

import { DecisionAudit, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { marksOf, setMarks } from '../src/marker.js';
import { AccessListMiddleware, AncestorMiddleware } from '../src/index.js';
import { auditUnscoped, domainContainer, storageUnscoped } from '../src/host.js';

const expect = chai.expect;
const tick = () => new Promise((r) => setImmediate(r));

describe('authz-orm host helpers', function () {
  this.timeout(30000);

  before(async () => {
    await testHost.installHost();
  });

  after(async () => {
    await testHost.uninstallHost();
  });

  afterEach(async () => {
    await testHost.resetHost();
  });

  it('the middlewares read authz.orm.domain, accessField and authz.admin.backend, with the schema defaults', () => {
    const list = new AccessListMiddleware() as unknown as { Domain: string; AccessField: string };
    const ancestors = new AncestorMiddleware() as unknown as { Domain: string; AdminBackend: string };
    expect([list.Domain, list.AccessField, ancestors.Domain, ancestors.AdminBackend]).to.deep.equal(['root', '$access', 'root', 'MemoryAuthzAdminBackend']);
    testHost.config().set(['authz', 'orm'], { domain: 'app', accessField: 'can' });
    testHost.config().set(['authz', 'admin', 'backend'], 'DbAuthzAdminBackend');
    expect([list.Domain, list.AccessField, ancestors.Domain, ancestors.AdminBackend]).to.deep.equal(['app', 'can', 'app', 'DbAuthzAdminBackend']);
  });

  it('domainContainer falls back to the DI root before the host created the domain', () => {
    expect(domainContainer('nope')).to.equal(DI.RootContainer);
  });

  it('marks live on the builder object, frozen, and are not enumerable', () => {
    const builder = {};
    expect(marksOf(builder)).to.equal(undefined);
    setMarks(builder, { unscoped: 'export' });
    expect(marksOf(builder)).to.deep.equal({ unscoped: 'export' });
    expect(Object.isFrozen(marksOf(builder))).to.equal(true);
    expect(Object.keys(builder)).to.deep.equal([]);
  });

  it('storageUnscoped reads the route @Unscoped reason of the request store', async () => {
    expect(storageUnscoped()).to.equal(undefined);
    await authzStorage().run({ Unscoped: 'report' } as never, async () => {
      expect(storageUnscoped()).to.equal('report');
    });
  });

  it('auditUnscoped records an unscoped entry when authz.audit.unscoped is on', async () => {
    const audit = new RecordingAudit();
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));
    await (await testHost.domains()).service('root');
    auditUnscoped('root', SYSTEM, 'export', 'task');
    await tick();
    expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: SYSTEM.type, id: SYSTEM.id }, reason: 'export', resource: { type: 'task' } }]);
    testHost.config().set(['authz', 'audit', 'unscoped'], false);
    await runWithPrincipal(SYSTEM, async () => auditUnscoped('root', SYSTEM, 'again', 'task'));
    await tick();
    expect(audit.of('unscoped')).to.have.length(1);
  });
});
