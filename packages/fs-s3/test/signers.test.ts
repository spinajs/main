import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from '@spinajs/fs';
import './../src/index.js';
import { TestConfiguration, TEST_RSA_PRIVATE_KEY } from './common.js';
import { S3BucketSigner } from './../src/s3BucketSigner.js';
import { CloudFrontSigner } from './../src/cloudFrontSigner.js';
import { fsS3 } from './../src/index.js';
import { S3Client } from '@aws-sdk/client-s3';

// ─── Helpers ──────────────────────────────────────────────────────────

async function provider(name: string) {
  return (await DI.resolve<fs>('__file_provider__', [name])) as fsS3;
}

// ═════════════════════════════════════════════════════════════════════
// Unit tests  – direct instantiation, no DI
// ═════════════════════════════════════════════════════════════════════

describe('URL signing – unit tests', function () {
  this.timeout(30000);

  let s3Client: S3Client;

  before(() => {
    s3Client = new S3Client({
      forcePathStyle: true,
      endpoint: 'http://localhost:4566',
      credentials: {
        secretAccessKey: 'test',
        accessKeyId: 'test',
      },
      region: 'us-west-1',
    });
  });

  after(() => {
    s3Client.destroy();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('S3BucketSigner', function () {
    let signer: S3BucketSigner;

    beforeEach(() => {
      signer = new S3BucketSigner({
        bucket: 'spinajs-test-bucket',
        s3Client,
      });
    });

    it('should return a presigned URL with default expiration', async () => {
      const url = await signer.sign('test-key.txt');

      expect(url).to.be.a('string');
      expect(url).to.include('test-key.txt');
      expect(url).to.include('X-Amz-Signature');
    });

    it('should return a presigned URL with custom expiration', async () => {
      const until = DateTime.now().plus({ minutes: 30 });
      const url = await signer.sign('test-key.txt', until);

      expect(url).to.be.a('string');
      expect(url).to.include('X-Amz-Signature');
      expect(url).to.include('X-Amz-Expires');
    });

    it('should clamp expired until to 1 second minimum', async () => {
      const until = DateTime.now().minus({ hours: 1 });
      const url = await signer.sign('test-key.txt', until);

      expect(url).to.be.a('string');
      expect(url).to.include('X-Amz-Signature');
    });
  });

  describe('CloudFrontSigner', function () {
    let signer: CloudFrontSigner;

    beforeEach(() => {
      signer = new CloudFrontSigner({
        privateKey: TEST_RSA_PRIVATE_KEY,
        publicKeyId: 'K2TESTPUBKEYID',
        domain: 'https://d111111abcdef8.cloudfront.net',
        bucket: 'spinajs-test-bucket',
      });
    });

    it('should return a signed URL with default expiration (1 hour)', async () => {
      const url = await signer.sign('images/photo.jpg');

      expect(url).to.be.a('string');
      expect(url).to.include('https://d111111abcdef8.cloudfront.net/images/photo.jpg');
      expect(url).to.include('Signature=');
      expect(url).to.include('Key-Pair-Id=K2TESTPUBKEYID');
    });

    it('should return a signed URL with custom expiration', async () => {
      const until = DateTime.now().plus({ hours: 2 });
      const url = await signer.sign('videos/movie.mp4', until);

      expect(url).to.be.a('string');
      expect(url).to.include('https://d111111abcdef8.cloudfront.net/videos/movie.mp4');
      expect(url).to.include('Signature=');
      expect(url).to.include('Key-Pair-Id=K2TESTPUBKEYID');
      expect(url).to.include('Expires=');
    });

    it('should include correct resource path in signed URL', async () => {
      const url = await signer.sign('assets/styles.css');

      expect(url).to.include('https://d111111abcdef8.cloudfront.net/assets/styles.css');
    });

    it('should use past date without throwing', async () => {
      const until = DateTime.now().minus({ hours: 1 });
      const url = await signer.sign('file.txt', until);

      expect(url).to.be.a('string');
      expect(url).to.include('Signature=');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// Integration tests  – signers injected into fsS3 via DI
// ═════════════════════════════════════════════════════════════════════

describe('URL signing – integration tests (fsS3)', function () {
  this.timeout(65000);

  before(async () => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    // Shared with fs-s3.test.ts on purpose – see the note in common.ts: `@Config`
    // memoizes the Configuration instance for the whole process, so only the first
    // registered Configuration subclass ever takes effect.
    DI.register(TestConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  });

  after(async () => {
    try {
      for (const name of ['aws-no-signer', 'aws-s3-signer', 'aws-cf-signer']) {
        const p = await provider(name);
        await p.dispose();
      }
    } catch {
      // ignore cleanup errors
    }
  });

  afterEach(() => {
    sinon.restore();
  });

  // ─── Negative: no signer configured ─────────────────────────────────

  describe('fsS3 without signer', function () {
    it('should throw InvalidOperation when calling getSignedUrl', async () => {
      const p = await provider('aws-no-signer');
      await p.write('signer-test.txt', 'hello');

      try {
        await p.getSignedUrl('signer-test.txt');
        expect.fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.include('no signer service configured');
      } finally {
        await p.rm('signer-test.txt');
      }
    });
  });

  // ─── S3 presigned URL signer via fsS3 ──────────────────────────────

  describe('fsS3 with S3 presigned URL signer', function () {
    it('should return a presigned S3 URL for an existing file', async () => {
      const p = await provider('aws-s3-signer');
      await p.write('signed-file.txt', 'signed content');

      const url = await p.getSignedUrl('signed-file.txt');

      expect(url).to.be.a('string');
      expect(url).to.include('signed-file.txt');
      expect(url).to.include('X-Amz-Signature');

      await p.rm('signed-file.txt');
    });

    it('should throw IOFail when file does not exist', async () => {
      const p = await provider('aws-s3-signer');

      try {
        await p.getSignedUrl('does-not-exist-xyz.txt');
        expect.fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.include('does not exists');
      }
    });
  });

  // ─── CloudFront signer via fsS3 ────────────────────────────────────

  describe('fsS3 with CloudFront signer', function () {
    it('should return a CloudFront signed URL for an existing file', async () => {
      const p = await provider('aws-cf-signer');
      await p.write('cf-signed-file.txt', 'cf content');

      const url = await p.getSignedUrl('cf-signed-file.txt');

      expect(url).to.be.a('string');
      expect(url).to.include('https://d111111abcdef8.cloudfront.net/cf-signed-file.txt');
      expect(url).to.include('Signature=');
      expect(url).to.include('Key-Pair-Id=K2TESTPUBKEYID');

      await p.rm('cf-signed-file.txt');
    });

    it('should throw IOFail when file does not exist', async () => {
      const p = await provider('aws-cf-signer');

      try {
        await p.getSignedUrl('cf-does-not-exist-xyz.txt');
        expect.fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.include('does not exists');
      }
    });
  });
});
