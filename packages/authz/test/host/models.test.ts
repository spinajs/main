import * as chai from 'chai';
import 'mocha';
import { StaticModel, TestLog } from '@spinajs/authz-testing';
import { AuthorizationModel, AuthzConfigError, TRUE } from '@spinajs/authz';
import { domains, installHost, instance, named, registerInRoot, resetHost, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;
const silent = (name: string) => new StaticModel({ name });
const allowing = (name: string) => new StaticModel({ name, votes: { '*': { permitWhen: TRUE } } });
const names = (models: readonly AuthorizationModel[]) => models.map((m) => m.name);

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('authz.models', function () {
  this.timeout(10000);
  before(installHost);
  after(uninstallHost);
  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {} });
  });

  describe('activation', () => {
    it('root without models activates nothing, denies every check and warns with the registered names', async () => {
      registerInRoot(AuthorizationModel, named('A', instance(allowing('a'))));
      const root = await rootService();
      expect(root.models()).to.deep.equal([]);
      expect((await root.check({ principal: { type: 'user', id: 'u', authenticated: true, source: 'test', attributes: {} }, permission: 'doc:read' })).allowed).to.equal(false);
      expect(TestLog.messages('warn').some((w) => w.includes('authz.models is not set') && w.includes('A'))).to.equal(true);
    });

    it('root with models activates only the listed names', async () => {
      registerInRoot(AuthorizationModel, named('A', instance(silent('a'))));
      registerInRoot(AuthorizationModel, named('B', instance(silent('b'))));
      setConfig(['authz', 'models'], ['B']);
      expect(names((await rootService()).models())).to.deep.equal(['b']);
    });

    it('a child inherits the instances root activated, without running their factory again', async () => {
      let made = 0;
      const A = () => {
        made++;
        return silent('a');
      };
      registerInRoot(AuthorizationModel, A);
      setConfig(['authz', 'models'], ['A']);
      const d = await domains();
      d.create('kid');
      const root = await rootService();
      const kid = await d.service('kid');
      expect(kid.models()).to.deep.equal(root.models());
      expect(made).to.equal(1);
    });

    it('a child models list adds to the inherited models and honours disable', async () => {
      registerInRoot(AuthorizationModel, named('A', instance(silent('a'))));
      registerInRoot(AuthorizationModel, named('B', instance(silent('b'))));
      registerInRoot(AuthorizationModel, named('C', instance(allowing('c'))));
      setConfig(['authz', 'models'], ['A', 'B']);
      setConfig(['authz', 'domains', 'kid'], { models: ['C'], disable: ['b'] });
      const d = await domains();
      d.create('kid');
      expect(names((await d.service('kid')).models())).to.deep.equal(['a', 'c']);
      expect(names((await rootService()).models())).to.deep.equal(['a', 'b']);
    });

    it('a child listing an inherited factory gets its own instance in its place', async () => {
      const A = () => silent('a');
      registerInRoot(AuthorizationModel, A);
      setConfig(['authz', 'models'], ['A']);
      setConfig(['authz', 'domains', 'kid'], { models: ['A'] });
      const d = await domains();
      d.create('kid');
      const root = await rootService();
      const kid = await d.service('kid');
      expect(names(kid.models())).to.deep.equal(['a']);
      expect(kid.models()[0]).to.not.equal(root.models()[0]);
    });

    it('what a child container registers stays inactive until its models list names it', async () => {
      const d = await domains();
      d.create('kid').register(named('Own', instance(allowing('own')))).as(AuthorizationModel);
      expect(names((await d.service('kid')).models())).to.deep.equal([]);
    });

    it('a grandchild without models inherits through a child that lists some', async () => {
      registerInRoot(AuthorizationModel, named('C', instance(allowing('c'))));
      setConfig(['authz', 'domains', 'kid'], { models: ['C'] });
      setConfig(['authz', 'domains', 'kid.sub'], { parent: 'kid' });
      const d = await domains();
      d.create('kid');
      d.create('kid.sub');
      const kid = await d.service('kid');
      const sub = await d.service('kid.sub');
      expect(sub.models()).to.deep.equal(kid.models());
    });
  });

  describe('configured domains', () => {
    it('root boot creates the domains a models list names, parents first', async () => {
      registerInRoot(AuthorizationModel, named('A', instance(allowing('a'))));
      setConfig(['authz', 'domains', 'arch'], { models: ['A'] });
      setConfig(['authz', 'domains', 'arch.sub'], { parent: 'arch', models: [] });
      setConfig(['authz', 'domains', 'plain'], { cache: { ttlSeconds: 1 } });
      await rootService();
      const d = await domains();
      expect(d.names()).to.deep.equal(['root', 'arch', 'arch.sub']);
      expect(names((await d.service('arch.sub')).models())).to.deep.equal(['a']);
    });

    it('leaves a domain the app created itself', async () => {
      registerInRoot(AuthorizationModel, named('A', instance(allowing('a'))));
      setConfig(['authz', 'domains', 'arch'], { models: ['A'] });
      const d = await domains();
      const own = d.create('arch');
      await rootService();
      expect(d.container('arch')).to.equal(own);
    });

    it('a configured parent that does not resolve fails the root boot', async () => {
      setConfig(['authz', 'domains', 'orphan'], { parent: 'nowhere', models: [] });
      setConfig(['authz', 'domains', 'nowhere'], { parent: 'orphan' });
      const err = await rejection(rootService());
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('cycle');
    });
  });

  describe('boot failures', () => {
    it('an unknown name fails the domain boot, naming the key', async () => {
      setConfig(['authz', 'domains', 'kid'], { models: ['Ghost'] });
      const d = await domains();
      d.create('kid');
      const err = await rejection(d.service('kid'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('authz.domains.kid.models lists "Ghost"');
    });

    it('an unknown name in authz.models fails the root boot', async () => {
      setConfig(['authz', 'models'], ['Ghost']);
      const err = await rejection(rootService());
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('authz.models lists "Ghost"');
    });
  });
});
