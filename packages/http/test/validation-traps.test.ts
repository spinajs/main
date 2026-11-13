import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { dir, httpApp, req, TestConfiguration } from './common.js';
import { Controllers, HttpServer } from '../src/index.js';

// TestConfiguration leaves out the validation section, so Ajv would not coerce; these are the shipped defaults.
class CoercingConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.validation = { allErrors: true, removeAdditional: false, useDefaults: true, coerceTypes: true, messages: false };
    (this.Config.system as { dirs: { controllers: string[] } }).dirs.controllers = [dir('./controllers-validation')];
  }
}

// 4.x answers application/problem+json, with the sanitized errors under `errors`
const fields = (res: { body: { errors?: { instancePath: string; keyword: string }[] } }) => (res.body.errors ?? []).map((e) => [e.instancePath, e.keyword]);

describe('http: non-finite numbers and deep-equal traps answer 400', function () {
  this.timeout(30000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({ configuration: CoercingConfiguration, resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app?.dispose();
  });

  const get = (path: string) => req().get(`validation-traps/${path}`).set('Accept', 'application/json');
  const post = (path: string, body: object) => req().post(`validation-traps/${path}`).set('Accept', 'application/json').send(body);

  describe('a bounded integer query parameter', () => {
    for (const route of ['page', 'pageText']) {
      for (const raw of ['-Infinity', 'Infinity', '1e400']) {
        it(`${route}?page=${raw} answers 400`, async () => {
          const res = await get(`${route}?page=${raw}`);
          expect(res.status, res.text).to.eq(400);
        });
      }

      it(`${route}?page=5 still answers 200`, async () => {
        const res = await get(`${route}?page=5`);
        expect(res.status, res.text).to.eq(200);
      });
    }

    it('pageQuery?q={"page":"-Infinity"} answers 400 at /page', async () => {
      const res = await get(`pageQuery?q=${encodeURIComponent('{"page":"-Infinity"}')}`);

      expect(res.status, res.text).to.eq(400);
      expect(fields(res)).to.deep.eq([['/page', 'type']]);
    });

    it('pageQuery?q={"page":"7"} is coerced and answers 200', async () => {
      const res = await get(`pageQuery?q=${encodeURIComponent('{"page":"7"}')}`);

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq({ value: '7', type: 'number' });
    });
  });

  describe('a JSON body', () => {
    for (const page of ['-Infinity', 'Infinity', '1e400']) {
      it(`answers 400 for a page of "${page}"`, async () => {
        const res = await post('pageBody', { page });

        expect(res.status, res.text).to.eq(400);
        expect(fields(res)).to.deep.eq([['/page', 'type']]);
      });
    }

    it('answers 400 for a 1e400 number literal', async () => {
      const res = await req().post('validation-traps/pageBody').set('Accept', 'application/json').set('Content-Type', 'application/json').send('{"page":1e400}');

      expect(res.status, res.text).to.eq(400);
    });

    it('keeps a finite page', async () => {
      const res = await post('pageBody', { page: '42' });

      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq({ value: '42', type: 'number' });
    });

    const traps: [string, object, string, string][] = [
      ['uniqueItems over objects with an own valueOf', { tags: [{ valueOf: 1 }, { valueOf: 1 }] }, '/tags', 'uniqueItems'],
      ['an object const with an own toString', { meta: { toString: false } }, '/meta', 'const'],
      ['an object const with an own valueOf', { meta: { valueOf: 1 } }, '/meta', 'const'],
      ['an object enum with an own valueOf', { kind: { valueOf: 1 } }, '/kind', 'enum'],
    ];

    for (const [name, trap, field, rule] of traps) {
      it(`answers 400, not 500, for ${name}`, async () => {
        const res = await post('item', { name: 'a', ...trap });

        expect(res.status, res.text).to.eq(400);
        expect(fields(res)).to.deep.eq([[field, rule]]);
      });
    }

    it('accepts distinct items and an equal const', async () => {
      const res = await post('item', { name: 'a', count: 1, tags: [{ a: 1 }, { valueOf: 1 }], meta: { a: 1 }, kind: 'plain' });

      expect(res.status, res.text).to.eq(200);
    });
  });
});
