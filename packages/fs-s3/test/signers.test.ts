import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { fs, FsBootsrapper, fsService } from '@spinajs/fs';
import './../src/index.js';
import { dir } from './common.js';
import { S3BucketSigner } from './../src/s3BucketSigner.js';
import { CloudFrontSigner } from './../src/cloudFrontSigner.js';
import { fsS3 } from './../src/index.js';
import { S3Client } from '@aws-sdk/client-s3';

// Minimal 2048-bit RSA private key for CloudFront signing tests.
// This is a throwaway test key – never use in production.
const TEST_RSA_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLH8bH9BjaMO/IOVB+sm5XuBnJTMaF2akVGbs8gS
V/Hl5JEdkp3W0bSAFihR3ilKhlCoA7BCLIAAG/WBwXdMdNO26bZSJzCOEM0J7BFN
TXGKIqSIMYdC8gVmDsPi7gNGV7RFZ7OHSlPEd53CiPFNsPGHFNK3LW5MO6JMgz+K
RNVGvmdsI9PjpWEjI7kMNqeCZWYdVMEvmLnhTCfhFkj3v5HHPOQ0zrMOPHdNJgLb
VVa1HK21BX3W/cccVP99ZiSfhiSQy91iLT7pNI3vZKIYsBZJNI7rNtqz1pGKe4Oh
YaFQsGLSjfWZWr9DBLRP6L3LKEfhbn8JxDhNFwIDAQABAoIBAF0cU86kpFg6MFOp
q3ipRMCclPJ7YR4kVkycABzVPMCrJl0tVhgBzBHFB3kDlrae02Mvam54KkI2dxPX
KvnuxA/Fd0n7CXNJmkHSN3LQN2DrmBKEhGpNPTBNbBj7NWsBaMMxLheNsk3KmGT+
RAXlhNLfcobCd33sNWH3RGQmx31QRZV+JH7qOSCP5fhJpFPO0J/l0M7Fg7DPTTFT
5SZGO5+XnPHlZd1bm93HZ7LdfkMdSuMi+CzmFCFan5WOLa5Y+LVpm5A18YVS/UF
GV2exwJ+I+VXUcqFkaG6R6GY2SKLbR0dHzPXBeIhNpMBA+PY8cKkPeWtCfFOMTmH
j7q7UEkCgYEA7+l6j/7kwNsEF+z1dc/igOhk5BKhFGi9gnFpF4QhGhF6oiU0iMi0
MB3fWbRpmMEj+vJLsL1GAd4BrfqKPoL0tAcPrT0bqsMcdbXJC3reYhRFO0UeLYCr
x/rskyFxP/sFRDSifHwn+KiDHMBX1FjqUqHU0EPi7YJcTRiEajjQKHkCgYEA6K4a
YCqHdGjlMFGOxebnkV8VRpBMWpk1OFi2Dr1HqjJOFJp0IHi/w3FKxmrHTEIYMd1m
i7UwAstRy8pUlV+rthAH4KCi7l/2OcsjSsNqNowRfnVPFEDy3fMZEI7JIqQ8V3cX
Bj4Frt12V+xLz4QFPL9G9eTVbtA9O3RCpn2d10cCgYBCo+K00fIUjEbCPiH5cPz0
XFa/VJxlai3tsR1P8btdHYswQtyBnB/R8b0yHPvVTXW75AleFmrRe/4DjvJP7M/K
AVoIRlaGvJbf/MuFhGWo45t9z8v4Gc1hsrv6PxjGWWlIGSfhHBPXTYm/FOyR6n/y
YDsJQANuOo1o+e3Lm/uf6QKBgAsB4f6JAFM2g6NeJVhpR3fT+gnmIoZ4tXSHIqMf
TwKKRsHT2FmUfLChfCqbWD+MWWMfp8XdC2e5htLCDBv/WQHT6JjWNWz+2JMl5sDO
Cv4wDAl1fJdJrJ8B3Vvsh3d/m4Vpp8YF+kfPbPuNxR8xYncaymIUx0hIAYJr/1VO
h9k/AoGBAOs3XELyLKUDCKeYGfED0bXfsBnz5DIY/J8nn1LxGXoQs9c4t0bnNSqK
ZOhF3p3Bu/G0fBHFxrHl/FM1e6JgGmSQfmPo66A1YjN6R+DRNdNULGkt2t6bA2bj
lHBr3jtIRHHPpWuYPfuAkth5Fd8qJzSU7dRamKGpN/VBJUFxQNL1
-----END RSA PRIVATE KEY-----`;

// ─── Test configuration with signer-enabled S3 providers ──────────────

class SignerTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      fs: {
        defaultProvider: 'test',
        s3: {
          config: {
            forcePathStyle: true,
            endpoint: 'http://localhost:4566',
            credentials: {
              secretAccessKey: 'test',
              accessKeyId: 'test',
            },
            region: 'us-west-1',
          },
        },
        providers: [
          {
            service: 'fsNative',
            name: 'test',
            basePath: dir('./files'),
          },
          {
            service: 'fsNativeTemp',
            name: 'fs-temp-s3',
            basePath: dir('./temp'),
            cleanup: true,
            cleanupInterval: 30,
            maxFileAge: 60,
          },
          // S3 provider WITHOUT signer (for negative test)
          {
            service: 'fsS3',
            name: 'aws-no-signer',
            bucket: 'spinajs-test-bucket',
          },
          // S3 provider WITH S3 presigned URL signer
          {
            service: 'fsS3',
            name: 'aws-s3-signer',
            bucket: 'spinajs-test-bucket',
            signer: {
              service: 'S3UrlSigner',
            },
          },
          // S3 provider WITH CloudFront signer
          {
            service: 'fsS3',
            name: 'aws-cf-signer',
            bucket: 'spinajs-test-bucket',
            signer: {
              service: 'CloudFrontUrlSigner',
              privateKey: TEST_RSA_PRIVATE_KEY,
              publicKeyId: 'K2TESTPUBKEYID',
              domain: 'https://d111111abcdef8.cloudfront.net',
            },
          },
        ],
      },
    };
  }
}

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

    DI.register(SignerTestConfiguration).as(Configuration);
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
