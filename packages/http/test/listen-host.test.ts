import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';
import _ from 'lodash';

import { releaseHttpServer, TestConfiguration } from './common.js';
import { HttpServer } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';

const PIPE_PATH = process.platform === 'win32' ? `\\\\.\\pipe\\spinajs-http-${process.pid}` : join(tmpdir(), `spinajs-http-${process.pid}.sock`);

abstract class ListenConfiguration extends TestConfiguration {
  protected abstract readonly http: Record<string, unknown>;

  public async resolve(): Promise<void> {
    await super.resolve();
    for (const [key, value] of Object.entries(this.http)) _.set(this.Config, ['http', key], value);
  }
}

// DI caches instances by class name, so every setting needs a named class of its own.
class DefaultListen extends ListenConfiguration {
  protected readonly http = {};
}

class LoopbackListen extends ListenConfiguration {
  protected readonly http = { host: '127.0.0.1' };
}

class PipeListen extends ListenConfiguration {
  protected readonly http = { port: PIPE_PATH };
}

class PipeWithHostListen extends ListenConfiguration {
  protected readonly http = { port: PIPE_PATH, host: '127.0.0.1' };
}

describe('HttpServer listen address', function () {
  this.timeout(15000);

  const registered: Class<Configuration>[] = [];

  async function serverWith(configuration: Class<ListenConfiguration>): Promise<HttpServer> {
    registered.push(configuration);
    DI.register(configuration).as(Configuration);
    await DI.resolve(Configuration);
    return DI.resolve<HttpServer>(HttpServer);
  }

  afterEach(async () => {
    await releaseHttpServer();
    for (const configuration of registered.splice(0)) DI.unregister(configuration);
    DI.uncache(Configuration);
  });

  after(() => {
    if (process.platform !== 'win32') rmSync(PIPE_PATH, { force: true });
  });

  it('listens on every interface when http.host is not set', async () => {
    const server = await serverWith(DefaultListen);
    await server.start();
    expect(['::', '0.0.0.0']).to.include((server.Server.address() as AddressInfo).address);
  });

  it('listens only on http.host', async () => {
    const server = await serverWith(LoopbackListen);
    await server.start();
    expect((server.Server.address() as AddressInfo).address).to.eq('127.0.0.1');
  });

  it('listens on a named pipe or socket path given in http.port', async () => {
    const server = await serverWith(PipeListen);
    await server.start();
    expect(server.Server.address()).to.eq(PIPE_PATH);
    await server.stop();
  });

  it('refuses http.host together with a pipe or socket path', async () => {
    const error = await serverWith(PipeWithHostListen).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).to.be.instanceOf(InvalidConfiguration);
    expect((error as Error).message).to.include('http.host');
  });
});

describe('http configuration schema: port and host', () => {
  const SCHEMAS = [HTTP_CONFIGURATION_SCHEMA];
  const bad = (http: Record<string, unknown>) => violationsOf(SCHEMAS, { http });

  afterEach(disposeBooted);

  it('refuses a port that is not a number, a path or in range', async () => {
    for (const port of ['abc', 'eighty', 70000, '70000', -1, 80.5, '', ' ', true, false]) {
      expect(await bad({ port }), JSON.stringify(port)).to.include('http.port');
    }
  });

  it('coerces a port given as text, as from an environment variable', async () => {
    const { configuration } = await boot(SCHEMAS, { http: { port: '8080' } });
    expect(configuration.get('http.port')).to.eq(8080);
  });

  it('accepts port 0, 65535 and null (a free port)', async () => {
    for (const port of [0, 65535, null]) expect(await bad({ port }), String(port)).to.deep.eq([]);
  });

  it('keeps a Windows pipe path and a Unix socket path as given', async () => {
    for (const port of ['\\\\.\\pipe\\app', '/run/app.sock', './app.sock']) {
      const { configuration } = await boot(SCHEMAS, { http: { port } });
      expect(configuration.get('http.port'), port).to.eq(port);
    }
  });

  it('accepts a host and refuses an empty one', async () => {
    expect(await bad({ host: '127.0.0.1' })).to.deep.eq([]);
    expect(await bad({ host: '' })).to.include('http.host');
  });
});
