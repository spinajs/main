import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { generateKeyPairSync } from 'crypto';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Freshly generated, throwaway RSA private key used only to exercise the CloudFront
 * URL signer in tests. It is generated per test run, never leaves this process and the
 * signatures it produces are never verified against a real CloudFront distribution.
 *
 * NEVER use a key like this in production.
 *
 * PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) is what `@aws-sdk/cloudfront-signer`
 * documents; PKCS#8 also parses, but we match the documented shape.
 */
export const TEST_RSA_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

export class TestConfiguration extends FrameworkConfiguration {
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
            // needed with localstack testing
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
            service: 'fsS3',
            name: 'aws',
            bucket: 'spinajs-test-bucket',
          },
          {
            service: 'fsNative',
            name: 'fs-temp-s3-local',
            basePath: dir('./temp'),
          },
          {
            service: 'fsTemp',
            name: 'fs-temp-s3',
            provider: 'fs-temp-s3-local',
            cleanup: true,
            cleanupInterval: 30,
            maxFileAge: 60,
          },

          // ─── Providers used by signers.test.ts ───────────────────────
          // They live here, in this one config, rather than in a second
          // FrameworkConfiguration, because Mocha runs every test file in one process and
          // a single shared config for the process is the convention for this suite.
          //
          // This was once a hard requirement: `@Config`
          // (packages/configuration/src/decorators.ts) memoized the resolved Configuration
          // *instance* in a decorator closure created at class-definition time, which
          // outlived DI.clearCache(), so whichever Configuration subclass was registered
          // first silently won for the whole run. That memoization has been removed —
          // `@Config` now resolves Configuration from the container on every access — so a
          // later DI.register(...).as(Configuration) does take effect. Keeping everything
          // in one config is still simpler than juggling per-file configs, so it stays.

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
