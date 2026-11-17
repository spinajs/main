import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { skipsAuthInDevelopment } from '@spinajs/authz-http';

import type { StudioCapabilities } from '../src/contracts/index.js';
import { StudioAccessContributor, StudioAccessPolicy } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

describe('StudioAccessPolicy', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;

  const get = (user?: string) => {
    const r = app.request().get('/_studio/api/capabilities').set('Accept', 'application/json');
    return user ? r.set('x-user', user) : r;
  };

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp();
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('answers a request without a principal 401', async () => {
    expect((await get()).status).to.eq(401);
  });

  it('answers a principal without studio:read 403', async () => {
    expect((await get('alice')).status).to.eq(403);
  });

  it('lets a principal holding studio:read through', async () => {
    expect((await get('bob')).status).to.eq(200);
  });

  it('fails closed when an endpoint has no slot', () => {
    expect(() => DI.resolve(StudioAccessPolicy, ['nothing'])).to.throw(/studio\.auth\.policies\.nothing/);
  });

  it('feeds every AccessPolicy slot permission to the boot checks of studio.auth.domain', async () => {
    const contributor = DI.resolve(StudioAccessContributor);
    const refs = (await contributor.contribute('root')).permissionRefs ?? [];
    expect([...new Set(refs.map((r) => r.permission))].sort()).to.deep.eq(['studio:explain', 'studio:read']);
    expect((await contributor.contribute('other')).permissionRefs).to.deep.eq([]);
  });
});

for (const appEnv of ['development', 'production']) {
  describe(`studio.auth.skipInDevelopment with APP_ENV=${appEnv}`, function () {
    this.timeout(30000);

    let app: TestApp;
    let unregister: () => void;
    const savedEnv = process.env.APP_ENV;

    const get = (user?: string) => {
      const r = app.request().get('/_studio/api/capabilities').set('Accept', 'application/json');
      return user ? r.set('x-user', user) : r;
    };

    before(async () => {
      process.env.APP_ENV = appEnv;
      unregister = registerHeaderSource();
      app = await startApp({ config: { 'studio.auth.skipInDevelopment': true } });
    });

    after(async () => {
      await stopApp();
      unregister();
      if (savedEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = savedEnv;
    });

    if (appEnv === 'development') {
      it('lets an anonymous request through and reports every Studio permission as held', async () => {
        const res = await get();
        expect(res.status).to.eq(200);
        expect((res.body as StudioCapabilities).permissions.sort()).to.deep.eq(['studio:explain', 'studio:read']);
      });
    } else {
      it('still checks every request', async () => {
        expect((await get()).status).to.eq(401);
        expect((await get('alice')).status).to.eq(403);
        const res = await get('bob');
        expect(res.status).to.eq(200);
        expect((res.body as StudioCapabilities).permissions.sort()).to.deep.eq(['studio:explain', 'studio:read']);
      });
    }
  });
}

describe('skipsAuthInDevelopment', () => {
  it('skips only for the exact flag, a development env and no production flag', () => {
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: false }, { APP_ENV: 'development' })).to.eq(true);
    expect(skipsAuthInDevelopment({ skipInDevelopment: 'true', isProduction: false }, { APP_ENV: 'development' })).to.eq(false);
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: true }, { APP_ENV: 'development' })).to.eq(false);
    expect(skipsAuthInDevelopment({ skipInDevelopment: true, isProduction: false }, {})).to.eq(false);
  });
});
