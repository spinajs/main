import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Controllers, HttpServer } from '@spinajs/http';

import { uploadEnv } from '../../support/env.js';

/** The suite's controllers dir: TestUploadController and UnguardedUploadController. */
export const TEST_CONTROLLERS_DIR = join(process.cwd(), 'test', 'http', 'controllers');

let started: Promise<HttpServer> | undefined;
let port = 0;

async function start(): Promise<HttpServer> {
  await uploadEnv();
  const cfg = await DI.resolve(Configuration);
  // Every installed package's config lists its controller dirs, and arrays concatenate (configuration/src/sources.ts:117-134), so replace the list.
  cfg.set(['system', 'dirs', 'controllers'], [TEST_CONTROLLERS_DIR]);
  cfg.set(['http', 'port'], 0);
  await DI.resolve(Controllers);
  const server = await DI.resolve<HttpServer>(HttpServer);
  await server.start();
  port = (server.Server.address() as AddressInfo).port;
  return server;
}

/** One http server per mocha process, over the shared upload environment (support/env.ts). */
export function uploadApp(): Promise<HttpServer> {
  return (started ??= start());
}

export function appPort(): number {
  if (port === 0) throw new Error('no upload app: call uploadApp() in a before hook first');
  return port;
}

// A root hook: it runs once, after every test file.
after(async function () {
  this.timeout(30000);
  if (!started) return;
  const server = await started;
  started = undefined;
  port = 0;
  await server.stop();
});
