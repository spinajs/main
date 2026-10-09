import 'mocha';
import { expect } from 'chai';
import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { fsService } from '@spinajs/fs';
import { Log, MemoryTarget } from '@spinajs/log';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { Controllers, HttpServer } from '../src/index.js';

const MEMORY = 'NoSecretEchoMemory';

function logLines(): string[] {
  return ((DI.get(MemoryTarget) as MemoryTarget | undefined)?.getRecords() ?? []).map((r) => JSON.stringify(r));
}

function expectNowhere(res: { status: number; text: string }, secrets: string[]): void {
  const lines = logLines();
  expect(lines, 'the error handler logged nothing').to.not.be.empty;
  for (const secret of secrets) {
    expect(res.text.includes(secret), `response holds ${secret}: ${res.text}`).to.eq(false);
    for (const line of lines) {
      expect(line.includes(secret), `log holds ${secret}: ${line}`).to.eq(false);
    }
  }
}

describe('http: no request value in 400 bodies or logs', function () {
  this.timeout(30000);

  before(async () => {
    uncacheControllers();

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    DI.register(TestConfiguration).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.start();

    // Loggers are cached by name for the whole process, so a target in this suite's config would miss
    // the ones earlier suites built: attach the memory target to every live logger instead.
    for (const logger of Log.Loggers.values()) {
      logger.addTarget({ name: MEMORY, type: 'MemoryTarget', limit: 100000 } as any);
    }
  });

  beforeEach(() => {
    (DI.get(MemoryTarget) as MemoryTarget | undefined)?.clear();
  });

  after(async () => {
    for (const logger of Log.Loggers.values()) {
      await logger.removeTarget(MEMORY);
    }
    await releaseHttpServer();
  });

  describe('a body failing schema validation', () => {
    it('400 without the secrets when a non-secret field fails', async () => {
      const secrets = { reauthPassword: 'Zq7reauthKx2Wm', password: 'Zq7passwdLp4Rt', newPassword: 'Zq7newpassVb8Hn' };
      const email = 'not-an-email-Zq7mailQs3';

      const res = await req()
        .post('secret-echo/account')
        .set('Accept', 'application/json')
        .send({ ...secrets, email });

      expect(res.status, res.text).to.eq(400);
      expect(res.body.details.map((d: { field: string }) => d.field)).to.include('/email');
      expectNowhere(res, [...Object.values(secrets), email]);
    });

    it('400 without the secrets when a secret field fails', async () => {
      const reauthPassword = 'Zq7reauthYt5Gd';
      const password = 'Zq7Hw9x';
      const newPassword = 'Zq7newpassMc6Fj!';

      const cases: [object, string[]][] = [
        [{ reauthPassword, password }, [reauthPassword, password]],
        [{ reauthPassword, newPassword }, [reauthPassword, newPassword]],
        [{ reauthPassword: { nested: 'Zq7reauthObj' }, password: 'Zq7passwdUe2Ka' }, ['Zq7reauthObj', 'Zq7passwdUe2Ka']],
      ];

      for (const [body, sent] of cases) {
        const res = await req().post('secret-echo/account').set('Accept', 'application/json').send(body);

        expect(res.status, res.text).to.eq(400);
        expect(res.body.details, res.text).to.be.an('array').that.is.not.empty;
        expectNowhere(res, sent);
      }
    });

    it('400 without the password when a $data confirmation fails', async () => {
      const password = 'Zq7confirmPwHt6Rv';
      const confirm = 'Zq7confirmTypoBn2';

      const res = await req().post('secret-echo/confirm').set('Accept', 'application/json').send({ password, confirm });

      expect(res.status, res.text).to.eq(400);
      expect(res.body.details.map((d: { field: string }) => d.field)).to.include('/confirm');
      expectNowhere(res, [password, confirm]);
    });
  });

  describe('a request body that is not valid JSON', () => {
    for (const [name, raw, secret] of [
      ['a truncated login body', '{"login":"a","password":"Zq7truncKr4Ws', 'Zq7truncKr4Ws'],
      ['an unquoted password', '{"login":"a","password":Zq7bareP}', 'Zq7bareP'],
    ]) {
      it(`answers 400 for ${name}, echoing nothing`, async () => {
        const res = await req().post('secret-echo/account').set('Accept', 'application/json').set('Content-Type', 'application/json').send(raw);

        expect(res.status, res.text).to.eq(400);
        expect(res.body.message).to.eq('request body is not valid JSON');
        expectNowhere(res, [secret]);
      });
    }
  });

  describe('an express.json verify failure, which carries the body-parser body', () => {
    it('sends no body', async () => {
      const res = await req()
        .post('secret-echo/account')
        .set('Accept', 'application/json')
        .set('x-test-refuse-body', '1')
        .send({ reauthPassword: 'Zq7verifyNb3Lw' });

      // body-parser's 403 is a plain Error, which the error map does not know.
      expect(res.status, res.text).to.eq(500);
      expect(res.body.type, res.text).to.eq('entity.verify.failed');
      expect(res.body).to.not.have.property('body');
      expectNowhere(res, ['Zq7verifyNb3Lw']);
    });
  });

  describe('a JSON route arg that is not valid JSON', () => {
    it('answers 400, echoing nothing', async () => {
      const res = await req().post('secret-echo/credentials').set('Accept', 'application/json').set('x-credentials', '{"password":Zq7hdrPw}').send({});

      expect(res.status, res.text).to.eq(400);
      expectNowhere(res, ['Zq7hdrPw']);
      expect(res.body.fieldName).to.eq('credentials');
    });
  });
});
