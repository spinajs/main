import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';

import { DefaultAuthzDomains, DefaultAuthzService, authz, AuthzConfigError, AuthzDomains, AuthzService } from '@spinajs/authz';
import { domains, installHost, resetHost, resetRoot, rootDomains, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('DefaultAuthzDomains', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  it('is the AuthzDomains root singleton', async () => {
    const d = await domains();
    expect(d).to.be.instanceOf(DefaultAuthzDomains);
    expect(await DI.resolve(AuthzDomains)).to.equal(d);
    const c = DI.RootContainer.child();
    expect(c.resolve(AuthzDomains)).to.equal(d);
    await c.dispose();
  });

  describe('create', () => {
    it('refuses root, bad names, live duplicates and unknown parents', async () => {
      const d = await domains();
      for (const bad of ['root', '', 'a b', 'a/b', 'x'.repeat(65), 42, undefined]) {
        expect(() => d.create(bad as string), String(bad)).to.throw(AuthzConfigError);
      }
      d.create('a');
      expect(() => d.create('a')).to.throw(AuthzConfigError, /"a"/);
      expect(() => d.create('b', 'nope')).to.throw(AuthzConfigError, /nope/);
      expect(() => d.create('b', 'a b')).to.throw(AuthzConfigError);
      expect(d.names()).to.deep.equal(['root', 'a']);
    });

    it('takes the configured parent; refuses an argument that differs from it', async () => {
      const d = await domains();
      d.create('p');
      setConfig(['authz', 'domains', 'k'], { parent: 'p' });
      expect(() => d.create('k', 'root')).to.throw(AuthzConfigError, /"k"/);
      const k = d.create('k');
      expect(k.Parent).to.equal(d.container('p'));
      expect(d.parentOf('k')).to.equal('p');
      expect(d.lineage('k')).to.deep.equal(['root', 'p', 'k']);

      setConfig(['authz', 'domains', 'k2'], { parent: 'p' });
      expect(d.create('k2', 'p').Parent).to.equal(d.container('p'));
      expect(d.create('k3').Parent).to.equal(DI.RootContainer);

      setConfig(['authz', 'domains', 'k4'], { parent: 'gone' });
      expect(() => d.create('k4')).to.throw(AuthzConfigError, /gone/);
      setConfig(['authz', 'domains', 'k5'], { parent: 5 });
      expect(() => d.create('k5')).to.throw(AuthzConfigError, /"k5"/);
    });
  });

  describe('lookup', () => {
    it('names() lists root first, then live domains in creation order', async () => {
      const d = await domains();
      d.create('b');
      d.create('a');
      d.create('a.x', 'a');
      expect(d.names()).to.deep.equal(['root', 'b', 'a', 'a.x']);
      expect(Object.isFrozen(d.names())).to.equal(true);
    });

    it('container() gives root and live domains, and throws for others', async () => {
      const d = await domains();
      expect(d.container('root')).to.equal(DI.RootContainer);
      const c = d.create('c');
      expect(d.container('c')).to.equal(c);
      expect(c.Parent).to.equal(DI.RootContainer);
      expect(() => d.container('unknown')).to.throw(AuthzConfigError, /unknown/);
      expect(d.describe(c)).to.deep.equal({ name: 'c', parent: 'root' });
      expect(d.describe(DI.RootContainer)).to.deep.equal({ name: 'root' });
      const plain = DI.RootContainer.child();
      expect(d.describe(plain)).to.equal(undefined);
      await plain.dispose();
    });

    it('affects() is true for no domain, the domain itself and its ancestors', async () => {
      const d = await domains();
      d.create('fs');
      d.create('fs.a', 'fs');
      d.create('other');
      expect(d.affects(undefined, 'other')).to.equal(true);
      expect(d.affects('root', 'fs.a')).to.equal(true);
      expect(d.affects('fs', 'fs.a')).to.equal(true);
      expect(d.affects('fs', 'fs')).to.equal(true);
      expect(d.affects('fs', 'other')).to.equal(false);
      expect(d.affects('fs', 'root')).to.equal(false);
      expect(d.affects('fs.a', 'fs')).to.equal(false);
      expect(d.affects(42 as never, 'other')).to.equal(true);
    });
  });

  describe('service', () => {
    it('resolves the domain service once; a child resolves its parent first', async () => {
      const d = await domains();
      d.create('mid');
      d.create('leaf', 'mid');
      expect(d.resolved('root')).to.equal(undefined);
      const leaf = await d.service('leaf');
      expect(leaf).to.be.instanceOf(DefaultAuthzService);
      expect(leaf.domain).to.equal('leaf');
      expect(await d.service('leaf')).to.equal(leaf);
      expect(d.resolved('leaf')).to.equal(leaf);
      expect(d.resolved('mid')).to.be.instanceOf(DefaultAuthzService);
      expect(d.resolved('root')).to.equal(await rootService());
      expect(await d.container('leaf').resolve(AuthzService)).to.equal(leaf);
      expect(await d.service('root')).to.equal(await rootService());
    });

    it('rejects a live domain whose service was disposed directly; returns an implementation that never entered a boot', async () => {
      const d = await domains();
      d.create('dd');
      const svc = await d.service('dd');
      await svc.dispose();
      const err = await rejection(d.service('dd'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.match(/AuthzService of domain "dd" is disposed/);

      const fake = { fake: true } as unknown as AuthzService;
      d.create('fake')
        .register(() => fake)
        .as(AuthzService);
      expect(await d.service('fake')).to.equal(fake);
    });

    it('rejects an unknown domain', async () => {
      const d = await domains();
      expect(await rejection(d.service('nope'))).to.be.instanceOf(AuthzConfigError);
    });
  });

  describe('disposal', () => {
    it('a disposed domain and its descendants leave names(); the name can be created again', async () => {
      const d = await domains();
      d.create('top');
      d.create('top.kid', 'top');
      d.create('keep');
      await d.service('top.kid');
      await d.container('top').dispose();
      expect(d.names()).to.deep.equal(['root', 'keep']);
      expect(d.resolved('top')).to.equal(undefined);
      expect(d.resolved('top.kid')).to.equal(undefined);
      expect(() => d.container('top.kid')).to.throw(AuthzConfigError);

      const again = d.create('top');
      expect(again).to.not.equal(undefined);
      const svc = await d.service('top');
      expect(svc.domain).to.equal('top');
      expect(d.names()).to.deep.equal(['root', 'keep', 'top']);
    });
  });

  describe('authz()', () => {
    it('throws while the AuthzDomains singleton does not exist', async () => {
      if (rootDomains()) DI.uncache(DefaultAuthzDomains);
      expect(rootDomains()).to.equal(undefined);
      expect(() => authz()).to.throw(AuthzConfigError, /await/);
    });

    it('returns the resolved root service and a resolved domain service, and throws otherwise', async () => {
      const d = await domains();
      expect(() => authz()).to.throw(AuthzConfigError, /root/);
      const root = await rootService();
      expect(authz()).to.equal(root);
      expect(authz('root')).to.equal(root);

      d.create('x');
      expect(() => authz('x')).to.throw(AuthzConfigError, /"x"/);
      const x = await d.service('x');
      expect(authz('x')).to.equal(x);
      await d.container('x').dispose();
      expect(() => authz('x')).to.throw(AuthzConfigError, /"x"/);

      await resetRoot();
      expect(() => authz()).to.throw(AuthzConfigError);
    });
  });
});
