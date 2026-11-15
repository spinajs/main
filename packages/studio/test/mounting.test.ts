import 'mocha';
import { expect } from 'chai';
import { FrameworkLogger } from '@spinajs/log';

import { assertStudioMountable, StudioMountRefused } from '../src/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

const capabilities = (app: TestApp, base = '/_studio') => app.request().get(`${base}/api/capabilities`).set('Accept', 'application/json').set('x-user', 'bob');

describe('assertStudioMountable', () => {
  it('is false while studio.enabled is not exactly true', () => {
    expect(assertStudioMountable({ enabled: false, allowProduction: false, isProduction: false })).to.eq(false);
    expect(assertStudioMountable({ enabled: 'true', allowProduction: false, isProduction: false })).to.eq(false);
  });

  it('refuses production unless studio.allowProduction is true', () => {
    expect(() => assertStudioMountable({ enabled: true, allowProduction: false, isProduction: true })).to.throw(StudioMountRefused, /studio\.allowProduction/);
    expect(assertStudioMountable({ enabled: true, allowProduction: true, isProduction: true })).to.eq(true);
  });

  it('mounts outside production', () => {
    expect(assertStudioMountable({ enabled: true, allowProduction: false, isProduction: false })).to.eq(true);
  });
});

describe('Studio mounting', function () {
  this.timeout(30000);

  let unregister: () => void;
  before(() => {
    unregister = registerHeaderSource();
  });
  after(() => unregister());
  afterEach(() => stopApp());

  it('registers no route while studio.enabled is false', async () => {
    const app = await startApp({ config: { 'studio.enabled': false } });
    expect((await capabilities(app)).status).to.eq(404);
  });

  it('registers no route in production without studio.allowProduction and logs an error', async () => {
    const proto = FrameworkLogger.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = proto.error;
    const errors: string[] = [];
    proto.error = function (this: unknown, ...args: unknown[]) {
      errors.push(args.filter((a) => typeof a === 'string').join(' '));
      return original.apply(this, args);
    };
    try {
      const app = await startApp({ config: { 'configuration.isProduction': true } });
      expect((await capabilities(app)).status).to.eq(404);
    } finally {
      proto.error = original;
    }
    expect(errors.some((e) => /studio\.allowProduction/.test(e))).to.eq(true);
  });

  it('mounts in production when studio.allowProduction is true', async () => {
    const app = await startApp({ config: { 'configuration.isProduction': true, 'studio.allowProduction': true } });
    expect((await capabilities(app)).status).to.eq(200);
  });

  it('mounts under studio.path', async () => {
    const app = await startApp({ config: { 'studio.path': '/ops/studio' } });
    expect((await capabilities(app, '/ops/studio')).status).to.eq(200);
    expect((await capabilities(app)).status).to.eq(404);
  });
});
