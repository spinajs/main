import * as chai from 'chai';
import 'mocha';
import { StaticModel } from '@spinajs/authz-testing';
import { AuthorizationModel, AuthzConfigError, TRUE } from '@spinajs/authz';
import { domains, installHost, instance, registerInRoot, resetHost, rootService, setConfig, uninstallHost } from './support.js';

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

describe('authz.use', function () {
  this.timeout(10000);
  before(installHost);
  after(uninstallHost);
  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {} });
  });

  describe('activation', () => {
    it('root without use keeps every root registration under AuthorizationModel active', async () => {
      registerInRoot(AuthorizationModel, instance(silent('legacy')));
      expect(names((await rootService()).models())).to.deep.equal(['legacy']);
    });

    it('root with use activates only the listed names', async () => {
      registerInRoot(AuthorizationModel, instance(silent('legacy')));
      registerInRoot('a', () => silent('a'));
      setConfig(['authz', 'use'], ['a']);
      expect(names((await rootService()).models())).to.deep.equal(['a']);
    });

    it('a child inherits the instances root activated, without running their factory again', async () => {
      let made = 0;
      registerInRoot('a', () => {
        made++;
        return silent('a');
      });
      setConfig(['authz', 'use'], ['a']);
      const d = await domains();
      d.create('kid');
      const root = await rootService();
      const kid = await d.service('kid');
      expect(kid.models()).to.deep.equal(root.models());
      expect(made).to.equal(1);
    });

    it('a child use adds to the inherited models and honours disable', async () => {
      registerInRoot('a', () => silent('a'));
      registerInRoot('b', () => silent('b'));
      registerInRoot('c', () => allowing('c'));
      setConfig(['authz', 'use'], ['a', 'b']);
      setConfig(['authz', 'domains', 'kid'], { use: ['c'], disable: ['b'] });
      const d = await domains();
      d.create('kid');
      expect(names((await d.service('kid')).models())).to.deep.equal(['a', 'c']);
      expect(names((await rootService()).models())).to.deep.equal(['a', 'b']);
    });

    it('a child listing an inherited name gets its own instance in its place', async () => {
      registerInRoot('a', () => silent('a'));
      setConfig(['authz', 'use'], ['a']);
      setConfig(['authz', 'domains', 'kid'], { use: ['a'] });
      const d = await domains();
      d.create('kid');
      const root = await rootService();
      const kid = await d.service('kid');
      expect(names(kid.models())).to.deep.equal(['a']);
      expect(kid.models()[0]).to.not.equal(root.models()[0]);
    });

    it('a child with use ignores what its container registers under AuthorizationModel', async () => {
      setConfig(['authz', 'domains', 'kid'], { use: [] });
      const d = await domains();
      d.create('kid').register(instance(allowing('own'))).as(AuthorizationModel);
      expect(names((await d.service('kid')).models())).to.deep.equal([]);
    });

    it('a grandchild without use still inherits through a child with use', async () => {
      registerInRoot('c', () => allowing('c'));
      setConfig(['authz', 'domains', 'kid'], { use: ['c'] });
      setConfig(['authz', 'domains', 'kid.sub'], { parent: 'kid' });
      const d = await domains();
      d.create('kid');
      d.create('kid.sub');
      const kid = await d.service('kid');
      const sub = await d.service('kid.sub');
      expect(sub.models()).to.deep.equal(kid.models());
    });
  });

  describe('boot failures', () => {
    it('an unknown name fails the domain boot, naming the key', async () => {
      setConfig(['authz', 'domains', 'kid'], { use: ['ghost'] });
      const d = await domains();
      d.create('kid');
      const err = await rejection(d.service('kid'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('authz.domains.kid.use lists "ghost"');
    });

    it('an unknown name in authz.use fails the root boot', async () => {
      setConfig(['authz', 'use'], ['ghost']);
      const err = await rejection(rootService());
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('authz.use lists "ghost"');
    });
  });
});
