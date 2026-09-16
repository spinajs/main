import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm, extractModelDescriptor } from '@spinajs/orm';
import { FileInfoService, FsBootsrapper, fsService } from '@spinajs/fs';
import { Controllers, HttpServer } from '@spinajs/http';
import { AuthorizedPolicy, RbacPolicy, ACL_CONTROLLER_DESCRIPTOR } from '@spinajs/rbac-http';
import { DbConfig, DbConfigFileHistory } from '@spinajs/configuration-db-source';
import { IRbacModelDescriptor, userModel } from '@spinajs/rbac';
import { expect } from 'chai';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import 'mocha';

import { TestConfiguration, FakePolicy, FakeFileInfo, FILES_DIR, FILES_FS, UPLOAD_DIR, binaryParser, req, seed, seedFileEntries, seedUser, xlsx } from './common.js';
import { ConfigurationController } from '../src/controllers/Configuration.js';
import { ConfigurationHttpBootstrapper } from '../src/bootstrap.js';
import configurationHttpConfig from '../src/config/configuration-http.js';

const JSON_HEADERS = { Accept: 'application/json' };

describe('configuration-http api', function () {
  this.timeout(25000);

  before(async () => {
    // The exception -> http response map ( __http_error_map__ ) is built by the
    // @HandleException decorators at module import time and stored in the DI
    // cache. clearCache() below would wipe it, and the decorators only run once,
    // so thrown-exception mapping ( eg. FromModel's OrmNotFoundException -> 404 )
    // would silently fall back to 500. Capture it and restore it after the reset.
    const errorMap = DI.get('__http_error_map__');
    DI.clearCache();
    if (errorMap) {
      DI.RootContainer.Cache.add('__http_error_map__', errorMap);
    }

    const fsBootstrapper = await DI.resolve(FsBootsrapper);
    fsBootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.setESMModuleSupport();

    // bypass auth so we can exercise controller logic
    DI.register(FakePolicy).as(AuthorizedPolicy);
    DI.register(FakePolicy).as(RbacPolicy);
    DI.register(FakeFileInfo).as(FileInfoService);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      // skip the db-source bootstrapper, it installs a watch timer that would
      // keep the event loop alive after the suite finishes
      if (b.constructor.name === 'DbConfigSourceBotstrapper') {
        continue;
      }
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve(HttpServer);
    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();

    const orm = DI.get(Orm);
    orm?.dispose();
    DI.uncache(Orm);
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await DbConfig.truncate();
    await seed();
  });

  describe('GET /configuration', () => {
    it('lists all entries', async () => {
      const res = await req().get('configuration').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body).to.be.an('array').with.lengthOf(11);
      expect(res.body.map((e: any) => e.Slug)).to.include.members(['app.name', 'mail.from', 'app.maxUsers']);
    });

    it('filters by group', async () => {
      const res = await req().get('configuration?group=mail').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body).to.be.an('array').with.lengthOf(1);
      expect(res.body[0].Slug).to.equal('mail.from');
    });
  });

  describe('GET /configuration/:slug', () => {
    it('returns a single entry', async () => {
      const res = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body.Slug).to.equal('app.name');
      expect(res.body.Value).to.equal('spinajs');
      expect(res.body.Type).to.equal('string');
    });

    it('returns the entry meta as an object', async () => {
      const res = await req().get('configuration/app.maxUsers').set(JSON_HEADERS);
      expect(res).to.have.status(200);
      expect(res.body.Meta).to.deep.equal({ min: 1, max: 100 });
    });

    it('returns 404 for unknown slug', async () => {
      const res = await req().get('configuration/does.not.exist').set(JSON_HEADERS);
      expect(res).to.have.status(404);
    });
  });

  describe('PATCH /configuration/:slug', () => {
    it('updates a string value and persists it', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'changed' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('changed');

      const get = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('changed');
    });

    it('coerces and stores an integer value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50 });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('50');
    });

    it('stores a boolean as canonical true/false', async () => {
      const res = await req().patch('configuration/app.debug').set(JSON_HEADERS).send({ Value: true });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('true');

      const get = await req().get('configuration/app.debug').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('true');
    });

    it('updates a date value in canonical ISO format', async () => {
      const res = await req().patch('configuration/app.startDate').set(JSON_HEADERS).send({ Value: '2021-06-15' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('2021-06-15');
    });

    it('accepts an allowed oneOf value', async () => {
      const res = await req().patch('configuration/app.theme').set(JSON_HEADERS).send({ Value: 'light' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('light');
    });

    it('accepts a manyOf subset and stores it canonically', async () => {
      const res = await req().patch('configuration/app.features').set(JSON_HEADERS).send({ Value: ['a', 'c'] });
      expect(res).to.have.status(200);
      expect(JSON.parse(res.body.Value)).to.deep.equal(['a', 'c']);
    });

    it('accepts a float value within bounds', async () => {
      const res = await req().patch('configuration/app.ratio').set(JSON_HEADERS).send({ Value: 0.75 });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('0.75');
    });

    it('accepts a datetime-range and stores it joined by ;', async () => {
      const res = await req()
        .patch('configuration/app.window')
        .set(JSON_HEADERS)
        .send({ Value: ['2021-01-01T00:00:00.000+00:00', '2021-06-01T00:00:00.000+00:00'] });
      expect(res).to.have.status(200);
      expect((res.body.Value as string).split(';')).to.have.lengthOf(2);
    });

    it('validates the Default value too', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50, Default: 5 });
      expect(res).to.have.status(200);
      expect(res.body.Default).to.equal('5');
    });

    it('can toggle the Watch flag', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'spinajs', Watch: true });
      expect(res).to.have.status(200);
      expect(Boolean(res.body.Watch)).to.equal(true);
    });

    it('rejects an out-of-range integer', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 999 });
      expect(res).to.have.status(400);
    });

    it('rejects a non-integer value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 'abc' });
      expect(res).to.have.status(400);
    });

    it('rejects a value not in oneOf', async () => {
      const res = await req().patch('configuration/app.theme').set(JSON_HEADERS).send({ Value: 'blue' });
      expect(res).to.have.status(400);
    });

    it('rejects a manyOf value outside the allowed set', async () => {
      const res = await req().patch('configuration/app.features').set(JSON_HEADERS).send({ Value: ['a', 'z'] });
      expect(res).to.have.status(400);
    });

    it('rejects a non-array manyOf value', async () => {
      const res = await req().patch('configuration/app.features').set(JSON_HEADERS).send({ Value: 'a' });
      expect(res).to.have.status(400);
    });

    it('rejects an out-of-range float', async () => {
      const res = await req().patch('configuration/app.ratio').set(JSON_HEADERS).send({ Value: 5 });
      expect(res).to.have.status(400);
    });

    it('rejects an invalid Default value', async () => {
      const res = await req().patch('configuration/app.maxUsers').set(JSON_HEADERS).send({ Value: 50, Default: 999 });
      expect(res).to.have.status(400);
    });

    it('returns 404 when updating an unknown slug', async () => {
      const res = await req().patch('configuration/does.not.exist').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(404);
    });
  });

  describe('PATCH /configuration/:slug with a schema registered under the slug', () => {
    it('accepts a string value that satisfies the registered schema', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'short' });
      expect(res).to.have.status(200);
      expect(res.body.Value).to.equal('short');
    });

    it('rejects a string value violating the registered schema and keeps the stored value', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).send({ Value: 'ab' });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value');

      const get = await req().get('configuration/app.name').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('spinajs');
    });

    it('accepts a json object matching the registered schema', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 50, export: true } });
      expect(res).to.have.status(200);
      expect(JSON.parse(res.body.Value)).to.deep.equal({ perPage: 50, export: true });
    });

    it('rejects a json object with an out of range property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 0 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Value/perPage');
    });

    it('rejects a json object missing a required property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { export: true } });
      expect(res).to.have.status(400);
    });

    it('rejects a json object with an unknown property', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 10, other: 1 } });
      expect(res).to.have.status(400);
    });

    it('validates the Default value against the registered schema too', async () => {
      const res = await req().patch('configuration/app.limits').set(JSON_HEADERS).send({ Value: { perPage: 10 }, Default: { perPage: 1000 } });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.contain('Default');
    });

    it('keeps type-only validation for entries without a registered schema', async () => {
      const res = await req().patch('configuration/mail.from').set(JSON_HEADERS).send({ Value: 'x' });
      expect(res).to.have.status(200);
    });

    it('responds 500 naming the slug when the registered schema cannot be compiled, and keeps the stored value', async () => {
      const res = await req().patch('configuration/app.broken').set(JSON_HEADERS).send({ Value: 'y' });
      expect(res).to.have.status(500);
      expect(res.body.error.message).to.contain('app.broken');

      const get = await req().get('configuration/app.broken').set(JSON_HEADERS);
      expect(get.body.Value).to.equal('x');
    });
  });

  describe('file entries', () => {
    const upload = (slug: string, content: Buffer, filename: string, headers: Record<string, string> = {}) =>
      req()
        .post(`configuration/${slug}/file`)
        .set({ ...JSON_HEADERS, ...headers })
        .attach('file', content, { filename });

    const expectNothingStored = async (slug: string) => {
      expect(readdirSync(FILES_DIR)).to.deep.equal(['default.xlsx']);
      expect(await DbConfigFileHistory.where('Slug', slug)).to.be.empty;
      const entry = await req().get(`configuration/${slug}`).set(JSON_HEADERS);
      expect(entry.body.Value).to.equal('default.xlsx');
    };

    beforeEach(async () => {
      await DbConfigFileHistory.truncate();
      await seedFileEntries();
      await seedUser();

      for (const d of [FILES_DIR, UPLOAD_DIR]) {
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d, { recursive: true });
      }
      writeFileSync(join(FILES_DIR, 'default.xlsx'), xlsx('default'));
    });

    after(() => {
      for (const d of [FILES_DIR, UPLOAD_DIR]) {
        rmSync(d, { recursive: true, force: true });
      }
    });

    describe('POST /configuration/:slug/file', () => {
      it('stores the file under a generated name, sets Value and records the upload', async () => {
        const content = xlsx('first');

        const res = await upload('tpl.offer', content, 'My Offer.XLSX');

        expect(res).to.have.status(200);
        expect(res.body.Slug).to.equal('tpl.offer');
        expect(res.body.Value).to.match(/^My_Offer-\d{8}-\d{6}\.xlsx$/);
        expect(readFileSync(join(FILES_DIR, res.body.Value))).to.deep.equal(content);

        const get = await req().get('configuration/tpl.offer').set(JSON_HEADERS);
        expect(get.body.Value).to.equal(res.body.Value);

        const rows = await DbConfigFileHistory.where('Slug', 'tpl.offer');
        expect(rows).to.have.lengthOf(1);
        expect(rows[0].Fs).to.equal(FILES_FS);
        expect(rows[0].FileName).to.equal(res.body.Value);
        expect(rows[0].OriginalName).to.equal('My Offer.XLSX');
        expect(rows[0].Size).to.equal(content.length);
        expect(rows[0].Hash).to.equal(createHash('sha256').update(content).digest('hex'));
        expect(rows[0].UploadedBy).to.equal(1);
        expect(rows[0].ArchivedAt).to.not.exist;
      });

      it('removes the temporary upload file', async () => {
        await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        expect(readdirSync(UPLOAD_DIR)).to.be.empty;

        await upload('tpl.offer', Buffer.from('plain text'), 'first.xlsx');
        expect(readdirSync(UPLOAD_DIR)).to.be.empty;
      });

      it('rejects an entry that is not of type file', async () => {
        const res = await upload('app.name', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('not a file entry');
        expect(readdirSync(FILES_DIR)).to.deep.equal(['default.xlsx']);
      });

      it('rejects a file entry without file options', async () => {
        const res = await upload('tpl.noMeta', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(400);
        await expectNothingStored('tpl.noMeta');
      });

      it('rejects a request without a file', async () => {
        const res = await req().post('configuration/tpl.offer/file').set(JSON_HEADERS).field('note', 'no file');
        expect(res).to.have.status(400);
        await expectNothingStored('tpl.offer');
      });

      it('rejects a file over maxSize', async () => {
        const res = await upload('tpl.offer', Buffer.concat([xlsx('big'), Buffer.alloc(2048)]), 'big.xlsx');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('too large');
        await expectNothingStored('tpl.offer');
      });

      it('rejects a file with an extension outside the allowed list', async () => {
        const res = await upload('tpl.offer', xlsx('x'), 'offer.xls');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('extension');
        await expectNothingStored('tpl.offer');
      });

      it('rejects a file whose detected content type is not allowed', async () => {
        const res = await upload('tpl.offer', Buffer.from('plain text'), 'offer.xlsx');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('text/plain');
        await expectNothingStored('tpl.offer');
      });

      it('returns the ValidationFailed message of the entry validator as 400', async () => {
        const res = await upload('tpl.validated', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.equal('Template is missing the Offer sheet');
        await expectNothingStored('tpl.validated');
      });

      it('responds 500 naming an unregistered validator', async () => {
        const res = await upload('tpl.unknownValidator', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(500);
        expect(res.body.error.message).to.contain('NoSuchTemplateValidator');
        await expectNothingStored('tpl.unknownValidator');
      });

      it('rejects a generated name that fails the value schema registered for the slug', async () => {
        const res = await upload('tpl.pdfOnly', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('Value');
        await expectNothingStored('tpl.pdfOnly');
      });

      it('returns 404 for an unknown slug', async () => {
        const res = await upload('does.not.exist', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(404);
      });

      it('rejects an original name longer than 255 characters', async () => {
        const res = await upload('tpl.offer', xlsx('x'), `${'a'.repeat(251)}.xlsx`);
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('255');
        await expectNothingStored('tpl.offer');
      });

      it('rejects an extension longer than 16 characters', async () => {
        const res = await upload('tpl.validated', xlsx('x'), `a.${'x'.repeat(20)}`);
        expect(res).to.have.status(400);
        expect(res.body.error.message).to.contain('16');
        await expectNothingStored('tpl.validated');
      });

      it('responds 500 naming the slug and an unregistered fs provider', async () => {
        const res = await upload('tpl.unknownFs', xlsx('x'), 'offer.xlsx');
        expect(res).to.have.status(500);
        expect(res.body.error.message).to.contain('tpl.unknownFs').and.to.contain('no-such-fs');
        await expectNothingStored('tpl.unknownFs');
        expect(readdirSync(UPLOAD_DIR)).to.be.empty;
      });
    });

    describe('archiving', () => {
      type Recorder = (entry: DbConfig, data: Record<string, unknown>) => Promise<DbConfigFileHistory>;
      const controller = ConfigurationController.prototype as unknown as { recordUpload: Recorder };
      const recordUpload = controller.recordUpload;

      const historyRow = (fileName: string) =>
        new DbConfigFileHistory({ Slug: 'tpl.offer', Fs: FILES_FS, FileName: fileName, OriginalName: fileName, Size: 1, Hash: 'x', UploadedBy: 1, ArchivedPath: null }).insert();

      afterEach(() => {
        controller.recordUpload = recordUpload;
      });

      it('does not archive an upload recorded after the current one', async () => {
        controller.recordUpload = async function (this: unknown, ...args: Parameters<Recorder>) {
          const current = await recordUpload.apply(this, args);
          writeFileSync(join(FILES_DIR, 'newer.xlsx'), xlsx('newer'));
          await historyRow('newer.xlsx');
          return current;
        };

        const res = await upload('tpl.offer', xlsx('first'), 'first.xlsx');

        expect(res).to.have.status(200);
        expect(existsSync(join(FILES_DIR, 'newer.xlsx'))).to.be.true;
        const newer = await DbConfigFileHistory.where('FileName', 'newer.xlsx').first();
        expect(newer.ArchivedAt).to.not.exist;
      });

      it('does not archive an earlier upload stored under the current file name', async () => {
        controller.recordUpload = async function (this: unknown, ...args: Parameters<Recorder>) {
          await historyRow(args[1].FileName as string);
          return recordUpload.apply(this, args);
        };

        const res = await upload('tpl.offer', xlsx('first'), 'first.xlsx');

        expect(res).to.have.status(200);
        expect(readFileSync(join(FILES_DIR, res.body.Value))).to.deep.equal(xlsx('first'));
        const rows = await DbConfigFileHistory.where('FileName', res.body.Value);
        expect(rows).to.have.lengthOf(2);
        expect(rows.every((r) => r.ArchivedAt == null)).to.be.true;
      });

      it('moves the previous upload to archive/ and marks its history row', async () => {
        const first = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        const second = await upload('tpl.offer', xlsx('second'), 'second.xlsx');

        expect(second).to.have.status(200);
        expect(second.body.Value).to.match(/^second-/);

        const firstRow = await DbConfigFileHistory.where('FileName', first.body.Value).first();
        expect(firstRow.ArchivedPath).to.equal(`archive/${first.body.Value}`);
        expect(firstRow.ArchivedAt).to.exist;
        expect(existsSync(join(FILES_DIR, 'archive', first.body.Value))).to.be.true;
        expect(existsSync(join(FILES_DIR, first.body.Value))).to.be.false;

        const secondRow = await DbConfigFileHistory.where('FileName', second.body.Value).first();
        expect(secondRow.ArchivedAt).to.not.exist;
        expect(existsSync(join(FILES_DIR, second.body.Value))).to.be.true;

        // the default file has no history row, so it is never archived
        expect(existsSync(join(FILES_DIR, 'default.xlsx'))).to.be.true;
      });

      it('does not archive on PATCH', async () => {
        const first = await upload('tpl.offer', xlsx('first'), 'first.xlsx');

        const patch = await req().patch('configuration/tpl.offer').set(JSON_HEADERS).send({ Value: 'default.xlsx' });
        expect(patch).to.have.status(200);

        const row = await DbConfigFileHistory.where('FileName', first.body.Value).first();
        expect(row.ArchivedAt).to.not.exist;
        expect(existsSync(join(FILES_DIR, first.body.Value))).to.be.true;
      });

      it('does not archive a previous upload whose file name Value was raced back to after the current upload committed', async () => {
        const RACED_NAME = 'raced-back.xlsx';
        controller.recordUpload = async function (this: unknown, ...args: Parameters<Recorder>) {
          writeFileSync(join(FILES_DIR, RACED_NAME), xlsx('raced'));
          await historyRow(RACED_NAME);
          const current = await recordUpload.apply(this, args);
          // simulate a concurrent request that re-pointed Value at an older, still unarchived file
          // between this recordUpload transaction committing and archivePrevious running
          const raced = await DbConfig.where('Slug', 'tpl.offer').first();
          raced.Value = RACED_NAME as typeof raced.Value;
          await raced.update();
          return current;
        };

        const res = await upload('tpl.offer', xlsx('first'), 'first.xlsx');

        expect(res).to.have.status(200);
        const racedRow = await DbConfigFileHistory.where('FileName', RACED_NAME).first();
        expect(racedRow.ArchivedAt).to.not.exist;
        expect(existsSync(join(FILES_DIR, RACED_NAME))).to.be.true;
      });

      it('still accepts the upload when the previous file cannot be archived', async () => {
        const first = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        unlinkSync(join(FILES_DIR, first.body.Value));

        const second = await upload('tpl.offer', xlsx('second'), 'second.xlsx');

        expect(second).to.have.status(200);
        const firstRow = await DbConfigFileHistory.where('FileName', first.body.Value).first();
        expect(firstRow.ArchivedAt).to.not.exist;
        expect(firstRow.ArchivedPath).to.not.exist;
      });
    });

    describe('downloads and history', () => {
      const download = (path: string, headers: Record<string, string> = {}) => req().get(path).set(headers).buffer(true).parse(binaryParser);

      it('downloads the file named by the current Value', async () => {
        const res = await download('configuration/tpl.offer/file');
        expect(res).to.have.status(200);
        expect(res.body).to.deep.equal(xlsx('default'));
        expect(res.header['content-disposition']).to.contain('attachment').and.to.contain('default.xlsx');

        const uploaded = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        const after = await download('configuration/tpl.offer/file');
        expect(after.body).to.deep.equal(xlsx('first'));
        expect(after.header['content-disposition']).to.contain(uploaded.body.Value);
      });

      it('rejects downloading from an entry that is not a file entry', async () => {
        const res = await req().get('configuration/app.name/file').set(JSON_HEADERS);
        expect(res).to.have.status(400);
      });

      it('lists uploads newest first with their uploader', async () => {
        const first = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        const second = await upload('tpl.offer', xlsx('second'), 'second.xlsx', { 'x-test-user-id': '99' });

        const res = await req().get('configuration/tpl.offer/files').set(JSON_HEADERS);

        expect(res).to.have.status(200);
        expect(res.body).to.be.an('array').with.lengthOf(2);

        expect(res.body[0]).to.include({ Slug: 'tpl.offer', Fs: FILES_FS, FileName: second.body.Value, OriginalName: 'second.xlsx', UploadedBy: 99, ArchivedPath: null, ArchivedAt: null, Uploader: null });
        expect(res.body[0].UploadedAt).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(res.body[0].Hash).to.equal(createHash('sha256').update(xlsx('second')).digest('hex'));
        expect(res.body[0].Size).to.equal(xlsx('second').length);

        expect(res.body[1].FileName).to.equal(first.body.Value);
        expect(res.body[1].ArchivedPath).to.equal(`archive/${first.body.Value}`);
        expect(res.body[1].ArchivedAt).to.match(/Z$/);
        expect(res.body[1].Uploader).to.deep.equal({ Id: 1, Email: 'admin@spinajs.test', Login: 'admin' });
      });

      it('downloads an archived and the current version under their original names', async () => {
        await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        await upload('tpl.offer', xlsx('second'), 'second.xlsx');
        const list = await req().get('configuration/tpl.offer/files').set(JSON_HEADERS);
        const [secondRow, firstRow] = list.body;

        const archived = await download(`configuration/tpl.offer/files/${firstRow.Id}`);
        expect(archived).to.have.status(200);
        expect(archived.body).to.deep.equal(xlsx('first'));
        expect(archived.header['content-disposition']).to.contain('first.xlsx');

        const current = await download(`configuration/tpl.offer/files/${secondRow.Id}`);
        expect(current.body).to.deep.equal(xlsx('second'));
        expect(current.header['content-disposition']).to.contain('second.xlsx');
      });

      it('lists uploaders even when the user model is guarded by a resource the role lacks', async () => {
        const descriptor = extractModelDescriptor(userModel()) as IRbacModelDescriptor;
        const resource = descriptor.RbacResource;
        await upload('tpl.offer', xlsx('first'), 'first.xlsx');

        descriptor.RbacResource = 'users';
        try {
          const res = await req().get('configuration/tpl.offer/files').set(JSON_HEADERS);

          expect(res).to.have.status(200);
          expect(res.body[0].Uploader).to.deep.equal({ Id: 1, Email: 'admin@spinajs.test', Login: 'admin' });
        } finally {
          descriptor.RbacResource = resource;
        }
      });

      it('downloads a version from archive/ when it was moved but its row was not updated', async () => {
        const uploaded = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        const row = await DbConfigFileHistory.where('FileName', uploaded.body.Value).first();
        mkdirSync(join(FILES_DIR, 'archive'), { recursive: true });
        renameSync(join(FILES_DIR, uploaded.body.Value), join(FILES_DIR, 'archive', uploaded.body.Value));

        const res = await download(`configuration/tpl.offer/files/${row.Id}`);

        expect(res).to.have.status(200);
        expect(res.body).to.deep.equal(xlsx('first'));
      });

      it('returns 404 for a version id that is not a positive integer', async () => {
        for (const id of ['abc', '0', '-1', '1.5']) {
          const res = await req().get(`configuration/tpl.offer/files/${id}`).set(JSON_HEADERS);
          expect(res, id).to.have.status(404);
        }
      });

      it('responds 500 naming the slug and an unregistered fs provider on download', async () => {
        const current = await req().get('configuration/tpl.unknownFs/file').set(JSON_HEADERS);
        expect(current).to.have.status(500);
        expect(current.body.error.message).to.contain('tpl.unknownFs').and.to.contain('no-such-fs');

        const row = new DbConfigFileHistory({ Slug: 'tpl.unknownFs', Fs: 'no-such-fs', FileName: 'a.xlsx', OriginalName: 'a.xlsx', Size: 1, Hash: 'x', UploadedBy: 1, ArchivedPath: null });
        await row.insert();
        const version = await req().get(`configuration/tpl.unknownFs/files/${row.Id}`).set(JSON_HEADERS);
        expect(version).to.have.status(500);
        expect(version.body.error.message).to.contain('tpl.unknownFs').and.to.contain('no-such-fs');
      });

      it('returns 404 for a version of another entry', async () => {
        const uploaded = await upload('tpl.offer', xlsx('first'), 'first.xlsx');
        const row = await DbConfigFileHistory.where('FileName', uploaded.body.Value).first();

        const res = await req().get(`configuration/tpl.validated/files/${row.Id}`).set(JSON_HEADERS);
        expect(res).to.have.status(404);
      });
    });

    describe('permissions', () => {
      it('forbids uploading for a role without updateAny', async () => {
        const res = await upload('tpl.offer', xlsx('x'), 'offer.xlsx', { 'x-test-role': 'user' });
        expect(res).to.have.status(403);
        expect(readdirSync(FILES_DIR)).to.deep.equal(['default.xlsx']);
      });

      it('forbids downloads and history for a role without readAny', async () => {
        const headers = { ...JSON_HEADERS, 'x-test-role': 'user' };
        expect(await req().get('configuration/tpl.offer/file').set(headers)).to.have.status(403);
        expect(await req().get('configuration/tpl.offer/files').set(headers)).to.have.status(403);
        expect(await req().get('configuration/tpl.offer/files/1').set(headers)).to.have.status(403);
      });
    });
  });

  describe('model-level RBAC', () => {
    // the `configuration` resource is bound to the DbConfig model, so the query
    // middleware denies a role without the grant even though the route policy is
    // faked ( see FakePolicy / the x-test-role header in test/common.ts )
    it('forbids reading configuration for a non-admin role', async () => {
      const res = await req().get('configuration').set(JSON_HEADERS).set('x-test-role', 'user');
      expect(res).to.have.status(403);
    });

    it('forbids updating configuration for a non-admin role', async () => {
      const res = await req().patch('configuration/app.name').set(JSON_HEADERS).set('x-test-role', 'user').send({ Value: 'nope' });
      expect(res).to.have.status(403);
    });
  });
});

describe('configuration-http rbac wiring', () => {
  it('declares the configuration resource and route permissions', () => {
    const descriptor = Reflect.getMetadata(ACL_CONTROLLER_DESCRIPTOR, ConfigurationController.prototype);
    expect(descriptor).to.be.an('object');
    expect(descriptor.Resource).to.equal('configuration');
    expect(descriptor.Routes.get('list').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('get').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('update').Permission).to.deep.equal(['updateAny']);
    expect(descriptor.Routes.get('uploadFile').Permission).to.deep.equal(['updateAny']);
    expect(descriptor.Routes.get('downloadFile').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('listFiles').Permission).to.deep.equal(['readAny']);
    expect(descriptor.Routes.get('downloadFileVersion').Permission).to.deep.equal(['readAny']);
  });

  it('grants configuration management only through an admin sub-role', () => {
    const grants = (configurationHttpConfig as any).rbac.grants;

    // dedicated admin sub-role holds the actual configuration resource grants
    expect(grants['admin.configuration'].configuration).to.have.property('read:any');
    expect(grants['admin.configuration'].configuration).to.have.property('update:any');

    // admin ( and system, which extends admin in @spinajs/rbac ) inherits it
    expect(grants.admin.$extend).to.include('admin.configuration');

    // no other role defined by this module gets configuration access - it is
    // admin-only ( guest / user roles come from the base rbac config, ungranted )
    const rolesWithConfig = Object.keys(grants).filter((role) => (grants[role] as Record<string, unknown>).configuration !== undefined);
    expect(rolesWithConfig).to.deep.equal(['admin.configuration']);
  });

  it('binds the DbConfig model to the configuration RBAC resource', () => {
    // @Model('configuration') on DbConfig only names the db table; the bootstrapper
    // declares the RBAC resource so the model-permission middleware enforces
    // `configuration` grants on every DbConfig query.
    new ConfigurationHttpBootstrapper().bootstrap();
    const descriptor = extractModelDescriptor(DbConfig) as { RbacResource?: string };
    expect(descriptor?.RbacResource).to.equal('configuration');
  });
});
