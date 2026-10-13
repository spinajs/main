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
    it('answers 400 with a fixed message when the hook throws a plain Error', async () => {
      const res = await req()
        .post('secret-echo/account?token=Zq7verifyQsMf5Ra')
        .set('Accept', 'application/json')
        .set('x-test-refuse-body', '1')
        .send({ reauthPassword: 'Zq7verifyNb3Lw' });

      expect(res.status, res.text).to.eq(400);
      expect(res.body.message, res.text).to.eq('request body was refused');
      expect(res.body).to.not.have.property('type');
      expect(res.body).to.not.have.property('body');
      expect(res.body).to.not.have.property('stack');
      expectNowhere(res, ['Zq7verifyNb3Lw', 'Zq7verifyQsMf5Ra', 'request body refused']);

      const lines = logLines().filter((line) => line.includes('entity.verify.failed'));
      expect(lines, logLines().join('\n')).to.have.length(1);
      expect(lines[0]).to.include('POST').and.to.include('/secret-echo/account?token=[redacted]');
    });

    it('keeps the mapped answer of an app exception, without the body', async () => {
      const res = await req()
        .post('secret-echo/account')
        .set('Accept', 'application/json')
        .set('x-test-forbid-body', '1')
        .send({ reauthPassword: 'Zq7forbidVc2Jt' });

      expect(res.status, res.text).to.eq(403);
      expect(res.body).to.not.have.property('body');
      expectNowhere(res, ['Zq7forbidVc2Jt']);
    });
  });

  describe('secrets in the query string', () => {
    const secrets = ['Zq7qsTokenBd4Lc', 'Zq7qsPasswdMx8Qe', 'Zq7qsCodeTw2Hy', 'Zq7qsBareJn5Sv'];
    const query = `token=${secrets[0]}&password=${secrets[1]}&code=${secrets[2]}&${secrets[3]}`;

    function expectKeysLogged() {
      const lines = logLines();
      for (const key of ['token=[redacted]', 'password=[redacted]', 'code=[redacted]']) {
        expect(lines.some((line) => line.includes(key)), `no log line names ${key}`).to.eq(true);
      }
    }

    it('reach no log line of a failing route', async () => {
      const res = await req().post(`secret-echo/account?${query}`).set('Accept', 'application/json').send({ reauthPassword: 'short' });

      expect(res.status, res.text).to.eq(400);
      expectNowhere(res, secrets);
      expectKeysLogged();
    });

    it('reach neither the 404 nor its log line', async () => {
      const res = await req().get(`secret-echo/no-such-route?${query}`).set('Accept', 'application/json');

      expect(res.status, res.text).to.eq(404);
      expectNowhere(res, secrets);
      expectKeysLogged();
    });

    it('reach neither the 404 of an action returning nothing nor its log line', async () => {
      const res = await req().get(`secret-echo/nothing?${query}`).set('Accept', 'application/json');

      expect(res.status, res.text).to.eq(404);
      expectNowhere(res, secrets);
      expectKeysLogged();
      const marker = 'Resource not found GET:/secret-echo/nothing?token=[redacted]';
      expect(logLines().some((line) => line.includes(marker)), `no log line holds ${marker}`).to.eq(true);
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

  describe('a bigint route arg that is not an integer', () => {
    it('answers 400 naming the field, echoing nothing', async () => {
      const res = await req().get('secret-echo/bigint?id=Zq7bigSecretFk6Ub').set('Accept', 'application/json');

      expect(res.status, res.text).to.eq(400);
      expect(res.body.fieldName, res.text).to.eq('id');
      expect(res.body.message).to.eq("Argument 'id' is not a valid integer");
      expectNowhere(res, ['Zq7bigSecretFk6Ub']);
    });

    it('still accepts an integer', async () => {
      const res = await req().get('secret-echo/bigint?id=9007199254740993').set('Accept', 'application/json');

      expect(res.status, res.text).to.eq(200);
      expect(res.body.id).to.eq('9007199254740993');
    });
  });

  describe('an XML body that is not valid XML', () => {
    for (const [name, raw, secret] of [
      ['a secret tag name', '<root><Zq7xmlTagGv4Np></root>', 'Zq7xmlTagGv4Np'],
      ['a secret attribute', '<root Zq7xmlAttrWc8Ky></root>', 'Zq7xmlAttrWc8Ky'],
      ['an unclosed secret tag', '<root><Zq7xmlOpenHs2Df>', 'Zq7xmlOpenHs2Df'],
    ]) {
      it(`answers 400 for ${name}, echoing nothing`, async () => {
        const res = await req().post('secret-echo/xml').set('Accept', 'application/json').set('Content-Type', 'application/xml').send(raw);

        expect(res.status, res.text).to.eq(400);
        expect(res.body.message).to.eq('request body is not valid XML');
        expectNowhere(res, [secret]);
      });
    }
  });
});
