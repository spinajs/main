import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import type { RequestHandler } from 'express';
import { FrameworkLogger } from '@spinajs/log';
import { mergeConfig } from '@spinajs/configuration';
import type { TestApp } from '@spinajs/testing';

import { httpApp, TestConfiguration } from './common.js';
import { configuredCookieParser, defaultMiddlewares, HttpServer, missingDefaultMiddlewares } from '../src/index.js';
// The built config, as in shipped-config.test.ts.
import shipped from '../lib/config/http.js';

const mine: RequestHandler = (_req, _res, next) => next();

const LOST = /http\.middlewares/;

describe('default middlewares', () => {
  describe('missingDefaultMiddlewares', () => {
    it('finds nothing missing in the default list', () => {
      expect(missingDefaultMiddlewares(defaultMiddlewares())).to.deep.equal([]);
    });

    it('finds nothing missing in the shipped config', () => {
      expect(missingDefaultMiddlewares(shipped.http.middlewares)).to.deep.equal([]);
    });

    it('finds nothing missing after the configuration merged the list', () => {
      const merged = mergeConfig({ http: { middlewares: [] as unknown[] } }, { http: { middlewares: [...defaultMiddlewares(), mine] } }, 'replace');
      expect(missingDefaultMiddlewares(merged.http.middlewares)).to.deep.equal([]);
    });

    it('names each missing handler', () => {
      expect(missingDefaultMiddlewares([mine])).to.deep.equal(['helmet', 'JSON body parser', 'form body parser', 'text body parser', 'cookie parser']);
      expect(missingDefaultMiddlewares(defaultMiddlewares().slice(1))).to.deep.equal(['helmet']);
    });

    it('counts the exported cookie parser', () => {
      expect(missingDefaultMiddlewares([configuredCookieParser])).to.not.include('cookie parser');
    });

    it('builds new handlers on each call', () => {
      expect(defaultMiddlewares()[0]).to.not.equal(defaultMiddlewares()[0]);
    });
  });

  describe('at boot', () => {
    let app: TestApp | undefined;
    let warn: sinon.SinonSpy;

    async function boot(middlewares: RequestHandler[]) {
      class ListConfiguration extends TestConfiguration {
        public async resolve(): Promise<void> {
          await super.resolve();
          (this.Config as { http: Record<string, unknown> }).http.middlewares = middlewares;
        }
      }

      app = await httpApp({ configuration: ListConfiguration });
      await app.resolve(HttpServer);
    }

    const warnings = () => warn.getCalls().filter((c) => c.args.some((a) => LOST.test(String(a))));

    beforeEach(() => {
      warn = sinon.spy(FrameworkLogger.prototype, 'warn');
    });

    afterEach(async () => {
      sinon.restore();
      await app?.dispose();
      app = undefined;
    });

    it('stays silent for the default list', async () => {
      await boot(defaultMiddlewares());
      expect(warnings()).to.have.length(0);
    });

    it('stays silent for a list that spreads the defaults', async () => {
      await boot([...defaultMiddlewares(), mine]);
      expect(warnings()).to.have.length(0);
    });

    it('warns once for a list without helmet, naming what is missing and how to keep the defaults', async () => {
      await boot(defaultMiddlewares().slice(1));
      expect(warnings()).to.have.length(1);

      const text = warnings()[0].args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      expect(text).to.contain('helmet');
      expect(text).to.not.contain('cookie parser');
      expect(text).to.contain('defaultMiddlewares()');
      // An app's own helmet() carries no tag, so the message cannot claim the headers are gone.
      expect(text).to.match(/own/);
    });

    it('names the body parsers and the cookie parser too', async () => {
      await boot([mine]);
      expect(warnings()).to.have.length(1);
      const text = JSON.stringify(warnings()[0].args);
      for (const name of ['helmet', 'JSON body parser', 'form body parser', 'text body parser', 'cookie parser']) expect(text).to.contain(name);
    });
  });
});
