import '@spinajs/log';
import './capture.js';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';

import { UPLOAD_EVENT_NAMES } from '../../src/index.js';

/** Base directory of the two test providers; env.ts removes it after the run. */
export const TEST_ROOT = mkdtempSync(join(tmpdir(), 'spinajs-upload-'));

const CAPTURE_LOGGER = { targets: [{ name: 'capture', type: 'CaptureLogTarget' }], rules: [{ name: '*', level: 'trace', target: 'capture' }] };

// The shipped config routes every upload event to a black hole; onLoad merges after it and points them here instead.
const CAPTURED = Object.fromEntries(UPLOAD_EVENT_NAMES.map((name) => [name, { connection: 'capture' }]));

/** Tiny limits keep parts a few bytes long: a 10-byte file is parts of 4, 4 and 2 bytes. */
export const TEST_CONFIG = {
  logger: CAPTURE_LOGGER,
  // Migration.OnStartup stays off: env.ts runs the upload migration by hand, as teams/test/support/db.ts:48-56 does.
  db: { DefaultConnection: 'sqlite', Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' }], Aliases: { upload: 'default' }, StrictTableCheck: false },
  fs: {
    defaultProvider: 'upload-temp',
    providers: [
      { service: 'StrictFs', name: 'upload-temp', basePath: join(TEST_ROOT, 'temp') },
      { service: 'StrictFs', name: 'upload-files', basePath: join(TEST_ROOT, 'files') },
    ],
  },
  queue: { default: 'capture', routing: CAPTURED, connections: [{ name: 'capture', service: 'CaptureQueueClient', defaultQueueChannel: 'upload-test-jobs', defaultTopicChannel: 'upload-test-events' }] },
  upload: {
    fs: { temp: 'upload-temp', files: 'upload-files', prefix: 'uploads' },
    limits: { maxFileSize: 1024, partSize: 4, minPartSize: 1, maxPartSize: 64, maxParts: 100, maxOpenSessionsPerOwner: 3 },
  },
};

export class UploadTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return TEST_CONFIG;
  }
}

let booted: Promise<Configuration> | undefined;

/**
 * One root Configuration per mocha process. The bootstrappers run first, so the upload schema applies when the
 * Configuration boots (configuration/src/schemas.ts:28-37).
 */
export function bootConfiguration(): Promise<Configuration> {
  return (booted ??= (async () => {
    DI.setESMModuleSupport();
    DI.register(UploadTestConfiguration).as(Configuration);
    for (const b of await DI.resolve<Bootstrapper>(Array.ofType(Bootstrapper))) await b.bootstrap();
    return DI.resolve(Configuration);
  })());
}
