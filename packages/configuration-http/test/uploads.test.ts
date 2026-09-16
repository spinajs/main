import { DI, Bootstrapper } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { FileInfoService, FsBootsrapper, fsService } from '@spinajs/fs';
import type { IUploadedFile } from '@spinajs/http';
import { DbConfig } from '@spinajs/configuration-db-source';
import { expect } from 'chai';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DateTime } from 'luxon';
import 'mocha';

import { TestConfiguration, FakeFileInfo, FILES_DIR, FILES_FS, UPLOAD_DIR, seed, seedFileEntries, xlsx } from './common.js';
import { ConfigFileUploads } from '../src/uploads.js';
import { ConfigFileRejected, NotAFileEntry } from '../src/errors.js';
import { storedFileName } from '../src/files.js';

/** Writes `content` under UPLOAD_DIR and describes it the way the multipart parser would. */
function uploaded(content: Buffer, name: string): IUploadedFile {
  const filepath = join(UPLOAD_DIR, `${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  writeFileSync(filepath, content);
  return { Name: name, BaseName: name, Size: content.length, Type: '', OriginalFile: { filepath } } as unknown as IUploadedFile;
}

const entry = async (slug: string) => (await DbConfig.where('Slug', slug).first()) as DbConfig;

const rejects = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('ConfigFileUploads', function () {
  this.timeout(25000);

  let uploads: ConfigFileUploads;

  before(async () => {
    DI.clearCache();

    const fsBootstrapper = await DI.resolve(FsBootsrapper);
    fsBootstrapper.bootstrap();

    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(FakeFileInfo).as(FileInfoService);
    DI.setESMModuleSupport();

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      // the db-source bootstrapper installs a watch timer that would keep the event loop alive
      if (b.constructor.name === 'DbConfigSourceBotstrapper') {
        continue;
      }
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);
    uploads = await DI.resolve(ConfigFileUploads);
  });

  after(async () => {
    const orm = DI.get(Orm);
    orm?.dispose();
    DI.uncache(Orm);
    for (const d of [FILES_DIR, UPLOAD_DIR]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await DbConfig.truncate();
    await seed();
    await seedFileEntries();

    for (const d of [FILES_DIR, UPLOAD_DIR]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(FILES_DIR, 'default.xlsx'), xlsx('default'));
  });

  const nothingStored = async (slug: string) => {
    expect(readdirSync(FILES_DIR)).to.deep.equal(['default.xlsx']);
    expect(readdirSync(UPLOAD_DIR)).to.be.empty;
    expect(String((await entry(slug)).Value)).to.equal('default.xlsx');
  };

  describe('accept', () => {
    it('stores the file under a generated name with its sha256 and leaves Value alone', async () => {
      const content = xlsx('first');
      const e = await entry('tpl.offer');

      const accepted = await uploads.accept(e, uploaded(content, 'My Offer.XLSX'));

      expect(accepted.fs).to.equal(FILES_FS);
      expect(accepted.fileName).to.match(/^My_Offer-\d{8}-\d{6}\.xlsx$/);
      expect(accepted.originalName).to.equal('My Offer.XLSX');
      expect(accepted.size).to.equal(content.length);
      expect(accepted.hash).to.equal(createHash('sha256').update(content).digest('hex'));
      expect(accepted.mimeType).to.equal('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(accepted.entry).to.equal(e);
      expect(readFileSync(join(FILES_DIR, accepted.fileName))).to.deep.equal(content);
      expect(readdirSync(UPLOAD_DIR)).to.be.empty;
      expect(String((await entry('tpl.offer')).Value)).to.equal('default.xlsx');
    });

    it('removes the temporary file on rejection too', async () => {
      await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(Buffer.from('plain text'), 'first.xlsx')));
      expect(readdirSync(UPLOAD_DIR)).to.be.empty;
    });

    it('rejects an entry that is not of type file', async () => {
      const err = await rejects(async () => uploads.accept(await entry('app.name'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(NotAFileEntry);
      expect(readdirSync(FILES_DIR)).to.deep.equal(['default.xlsx']);
    });

    it('rejects a file entry without file options', async () => {
      expect(await rejects(async () => uploads.accept(await entry('tpl.noMeta'), uploaded(xlsx('x'), 'offer.xlsx')))).to.be.instanceOf(NotAFileEntry);
      await nothingStored('tpl.noMeta');
    });

    it('rejects a file over maxSize', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(Buffer.concat([xlsx('big'), Buffer.alloc(2048)]), 'big.xlsx')));
      expect(err).to.be.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.contain('too large');
      await nothingStored('tpl.offer');
    });

    it('rejects a file with an extension outside the allowed list', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(xlsx('x'), 'offer.xls')));
      expect((err as Error).message).to.contain('extension');
      await nothingStored('tpl.offer');
    });

    it('rejects a file whose detected content type is not allowed', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(Buffer.from('plain text'), 'offer.xlsx')));
      expect((err as Error).message).to.contain('text/plain');
      await nothingStored('tpl.offer');
    });

    it('returns the ValidationFailed message of the entry validator', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.validated'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.equal('Template is missing the Offer sheet');
      await nothingStored('tpl.validated');
    });

    it('throws naming an unregistered validator', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.unknownValidator'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(Error).and.not.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.contain('NoSuchTemplateValidator');
      await nothingStored('tpl.unknownValidator');
    });

    it('rejects a generated name that fails the value schema registered for the slug', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.pdfOnly'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.contain('Value');
      await nothingStored('tpl.pdfOnly');
    });

    it('rejects an original name longer than 255 characters', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(xlsx('x'), `${'a'.repeat(251)}.xlsx`)));
      expect((err as Error).message).to.contain('255');
      await nothingStored('tpl.offer');
    });

    it('throws naming the slug and an unregistered fs provider', async () => {
      const err = await rejects(async () => uploads.accept(await entry('tpl.unknownFs'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(Error).and.not.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.contain('tpl.unknownFs').and.to.contain('no-such-fs');
      await nothingStored('tpl.unknownFs');
    });

    it('rejects a second file that would be stored under the same name within one second', async () => {
      // the name is clock based: pre-create the names of this second and the next one
      const now = DateTime.utc();
      for (const at of [now, now.plus({ seconds: 1 })]) {
        writeFileSync(join(FILES_DIR, storedFileName('offer.xlsx', at)), 'x');
      }
      const err = await rejects(async () => uploads.accept(await entry('tpl.offer'), uploaded(xlsx('x'), 'offer.xlsx')));
      expect(err).to.be.instanceOf(ConfigFileRejected);
      expect((err as Error).message).to.contain('a moment ago');
    });
  });

  describe('commit', () => {
    it('sets Value to the accepted name', async () => {
      const e = await entry('tpl.offer');
      const accepted = await uploads.accept(e, uploaded(xlsx('first'), 'offer.xlsx'));

      await uploads.commit(e, accepted.fileName);

      expect(String((await entry('tpl.offer')).Value)).to.equal(accepted.fileName);
    });

    it('refuses a name outside the slug schema and an entry that is not a file entry', async () => {
      expect(await rejects(async () => uploads.commit(await entry('tpl.pdfOnly'), 'offer-20260916-121530.xlsx'))).to.be.instanceOf(ConfigFileRejected);
      expect(await rejects(async () => uploads.commit(await entry('app.name'), 'offer-20260916-121530.xlsx'))).to.be.instanceOf(NotAFileEntry);
      expect(String((await entry('tpl.pdfOnly')).Value)).to.equal('default.xlsx');
    });
  });

  describe('discard', () => {
    it('removes the stored file and tolerates a missing one', async () => {
      const e = await entry('tpl.offer');
      const accepted = await uploads.accept(e, uploaded(xlsx('first'), 'offer.xlsx'));
      expect(existsSync(join(FILES_DIR, accepted.fileName))).to.equal(true);

      await uploads.discard(accepted);
      expect(existsSync(join(FILES_DIR, accepted.fileName))).to.equal(false);

      await uploads.discard(accepted);
    });
  });
});
