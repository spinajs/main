import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import '@spinajs/templates-pug';
import { spawn } from 'node:child_process';
import { createReadStream } from 'fs';
import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import { DateTime } from 'luxon';
import { dir, TestConfiguration } from './common.js';
import { DefaultFileInfo, FileInfoService, FsBootsrapper, fsService, resolveExifToolPath } from '../src/index.js';

function exiftoolAvailable(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn(binary, ['-ver']);
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
    });
}

/**
 * Fake ChildProcess used to drive exiftool logic deterministically without the
 * real binary.
 */
class FakeChild extends EventEmitter {
    public stdout = new EventEmitter();
    public stderr = new EventEmitter();
    public stdin = new PassThrough();
    public kill = sinon.spy();
}

/**
 * DefaultFileInfo with the process spawn stubbed - emits canned output/exit code.
 */
class StubbedFileInfo extends DefaultFileInfo {
    public output = '';
    public errOutput = '';
    public exitCode = 0;
    public autoClose = true;
    public child = new FakeChild();
    public lastBinary?: string;
    public lastArgs?: string[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected spawnExif(binary: string, args: string[]): any {
        this.lastBinary = binary;
        this.lastArgs = args;

        const child = this.child;
        if (this.autoClose) {
            setImmediate(() => {
                if (this.output) child.stdout.emit('data', Buffer.from(this.output, 'utf-8'));
                if (this.errOutput) child.stderr.emit('data', Buffer.from(this.errOutput, 'utf-8'));
                child.emit('close', this.exitCode);
            });
        }
        return child;
    }
}

describe('fs fileinfo tests', function () {
    this.timeout(15000);

    before(async function () {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);

        await DI.resolve(fsService);

        // vendored exiftool should make these tests runnable everywhere. If the
        // binary is still not resolvable, skip on windows only - on linux ( CI )
        // run and fail loudly so a broken exiftool setup is not silently ignored.
        const available = await exiftoolAvailable(await resolveExifToolPath());
        if (!available && process.platform === 'win32') {
            this.skip();
        }
    });

    afterEach(() => {
        sinon.restore();
    });

    it('Should register file info service in DI container', async () => {
        expect(DI.check(FileInfoService)).to.be.true;
    });

    it('should throw path not exists', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        await expect(fInfo.getInfo('someFile.txt')).to.be.rejectedWith('Path someFile.txt not exists');
    });

    it('Should return basic file properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/test.txt"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 11
        })
    });

    it('Should return movie properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/sample-5s.mp4"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 2848208,
            MimeType: "video/mp4",
            Duration: 5.759,
            Width: 1920,
            Height: 1080,
            AudioChannels: 2
        });
    });

    it('Should return image properties', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfo(dir("sample-files/SamplePNGImage_100kbmb.png"));

        expect(result).to.be.not.null;
        expect(result).to.be.not.undefined;
        expect(result).to.include({
            FileSize: 104327,
            MimeType: "image/png",
            Width: 272,
            Height: 170,
        })
    });

    it('Should return info from a readable stream ( real exiftool )', async () => {
        const fInfo = await DI.resolve(FileInfoService);
        const result = await fInfo.getInfoFromStream(createReadStream(dir('sample-files/SamplePNGImage_100kbmb.png')));

        expect(result).to.be.not.null;
        expect(result.MimeType).to.eq('image/png');
        expect(result.Width).to.eq(272);
        expect(result.Height).to.eq(170);
    });
});

describe('fs fileinfo tests ( mocked exiftool )', function () {
    this.timeout(15000);

    before(async () => {
        const bootstrapper = DI.resolve(FsBootsrapper);
        bootstrapper.bootstrap();

        DI.register(TestConfiguration).as(Configuration);
        await DI.resolve(Configuration);
        await DI.resolve(fsService);
    });

    afterEach(() => {
        sinon.restore();
    });

    it('succeeds when exiftool writes warnings to stderr but exits 0', async () => {
        const svc = new StubbedFileInfo();
        svc.output = 'File Size : 11\nMIME Type : text/plain\n';
        svc.errOutput = 'Warning: [minor] Maker notes could not be parsed\n';
        svc.exitCode = 0;

        const info = await svc.getInfo(dir('sample-files/test.txt'));
        expect(info.FileSize).to.eq(11);
        expect(info.MimeType).to.eq('text/plain');
    });

    it('rejects with IOFail when exiftool exits non-zero', async () => {
        const svc = new StubbedFileInfo();
        svc.exitCode = 1;
        svc.errOutput = 'Error: File format error\n';

        await expect(svc.getInfo(dir('sample-files/test.txt'))).to.be.rejectedWith('exiftool exited with code 1');
    });

    it('keeps defined-but-zero values', async () => {
        const svc = new StubbedFileInfo();
        svc.output = 'Word Count : 0\nLine Count : 0\n';

        const info = await svc.getInfo(dir('sample-files/test.txt'));
        expect(info.WordCount).to.eq(0);
        expect(info.LineCount).to.eq(0);
    });

    it('preserves values that contain ": "', async () => {
        const svc = new StubbedFileInfo();
        svc.output = 'Comment : label: some value\n';

        const info = await svc.getInfo(dir('sample-files/test.txt'));
        expect((info.Raw as any).comment).to.eq('label: some value');
    });

    it('times out and kills the process', async () => {
        const config = DI.get(Configuration) as any;
        const original = config.get.bind(config);
        sinon.stub(config, 'get').callsFake((path: string, def?: unknown) =>
            path === 'fs.fileInfo.timeout' ? 50 : original(path, def),
        );

        const svc = new StubbedFileInfo();
        svc.autoClose = false; // process never closes

        await expect(svc.getInfo(dir('sample-files/test.txt'))).to.be.rejectedWith('timed out');
        expect(svc.child.kill.called).to.be.true;
    });

    it('uses the configured exiftool path', async () => {
        const config = DI.get(Configuration) as any;
        const original = config.get.bind(config);
        sinon.stub(config, 'get').callsFake((path: string, def?: unknown) =>
            path === 'fs.fileInfo.exifToolPath' ? '/custom/exiftool' : original(path, def),
        );

        const svc = new StubbedFileInfo();
        svc.output = 'File Size : 1\n';

        await svc.getInfo(dir('sample-files/test.txt'));
        expect(svc.lastBinary).to.eq('/custom/exiftool');
    });

    it('getInfoFromStream parses metadata piped through stdin', async () => {
        const svc = new StubbedFileInfo();
        svc.output = 'MIME Type : image/png\nImage Width : 10\n';

        const info = await svc.getInfoFromStream(Readable.from([Buffer.from('fake-content')]));
        expect(info.MimeType).to.eq('image/png');
        expect(info.Width).to.eq(10);
        expect(svc.lastArgs).to.include('-');
    });

    it('promotes every tag, not just a hardcoded subset', async () => {
        const svc = new StubbedFileInfo();
        // "Color Type" is not in the alias table - it must still be extracted generically
        svc.output = 'Image Width : 272\nColor Type : 6\nMegapixels : 0.046\n';

        const info = await svc.getInfo(dir('sample-files/test.txt'));

        // aliased tag -> friendly typed field
        expect(info.Width).to.eq(272);
        // non-aliased tags -> promoted under their PascalCased name
        expect(info.ColorType).to.eq(6);
        expect(info.Megapixels).to.eq(0.046);
        // and everything is in Raw
        expect((info.Raw as any).colorType).to.eq(6);
    });

    it('coerces date-shaped values to DateTime by value shape', async () => {
        const svc = new StubbedFileInfo();
        // neither tag is in the alias table - detection is by value shape, not field name
        svc.output = 'Create Date : 2024:01:15 10:30:45\nModify Date : 2024:02:20 08:15:00\n';

        const info = await svc.getInfo(dir('sample-files/test.txt'));

        expect(DateTime.isDateTime(info.CreateDate)).to.be.true;
        expect((info.CreateDate as DateTime).year).to.eq(2024);
        expect((info.CreateDate as DateTime).month).to.eq(1);
        expect(DateTime.isDateTime(info.ModifyDate)).to.be.true;
    });

    it('appends configured exiftool args before the file spec', async () => {
        const config = DI.get(Configuration) as any;
        const original = config.get.bind(config);
        sinon.stub(config, 'get').callsFake((path: string, def?: unknown) =>
            path === 'fs.fileInfo.args' ? ['-n', '-G'] : original(path, def),
        );

        const svc = new StubbedFileInfo();
        svc.output = 'File Size : 1\n';

        await svc.getInfo(dir('sample-files/test.txt'));

        expect(svc.lastArgs).to.include('-G');
        // file spec is the last arg
        expect(svc.lastArgs![svc.lastArgs!.length - 1]).to.eq(dir('sample-files/test.txt'));
    });
});
