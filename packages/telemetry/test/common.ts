import { FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import os from 'os';
import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export function srcDir(path: string) {
  return resolve(normalize(join(process.cwd(), 'src', path)));
}

export function req() {
  return chai.request('http://localhost:1337/');
}

export const TEST_TOKEN = 'test-token-123';

/**
 * Boots the telemetry controllers from `src` ( not the compiled `lib` ), with
 * the token policy ACTIVE — `configuration.isDevelopment` is false so the auth
 * tests exercise the real code path.
 */
export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      configuration: {
        isDevelopment: false,
      },
      system: {
        dirs: {
          // http's error-page pug templates render `__( )` translate helpers, so
          // the intl locales dir must be present or forbidden.pug / serverError.pug
          // fail to render and the framework falls back to a 500.
          locales: [resolve(normalize(join(process.cwd(), '..', 'http', 'src', 'locales')))],
          controllers: [srcDir('./controllers')],
        },
      },
      intl: {
        locales: ['en', 'pl'],
        defaultLocale: 'en',
        queryParameter: 'lang',
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          { service: 'fsNative', name: 'fs-temp', basePath: dir('./cache') },
          { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
          { service: 'fsNative', name: '__fs_controller_cache__', basePath: dir('./cache') },
          { service: 'fsNative', name: '__fs_swagger_cache__', basePath: dir('./cache') },
          { service: 'fsNative', name: '__fs_swagger_views__', basePath: resolve(normalize(join(process.cwd(), '..', 'http-swagger', 'src', 'views'))) },
          { service: 'fsNative', name: '__fs_http_response_templates__', basePath: resolve(normalize(join(process.cwd(), '..', 'http', 'src', 'views', 'responses'))) },
          { service: 'fsNative', name: '__fs_http_templates__', basePath: dir('./cache') },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      http: {
        port: 1337,
        cookie: { secret: 'dsa12!@E#!$' },
        middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true })],
        AcceptHeaders: 1 | 2,
        swagger: {
          enabled: true,
          title: 'Telemetry API',
          version: '1.0.0',
        },
      },
      telemetry: {
        auth: {
          token: TEST_TOKEN,
          policies: {
            metrics: 'TelemetryTokenPolicy',
            stats: 'TelemetryTokenPolicy',
            timeline: 'TelemetryTokenPolicy',
            routes: 'TelemetryTokenPolicy',
            perf: 'TelemetryTokenPolicy',
            health: 'PublicPolicy',
            ready: 'PublicPolicy',
          },
        },
        collectDefaultMetrics: false,
        prefix: 'http',
        buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
        apdexThresholdMs: 25,
        timeline: { length: 60, bucketMs: 60_000 },
        routes: { enabled: true, maxEntries: 500 },
        perf: { enabled: true, maxNames: 200 },
        health: { timeoutMs: 2000, failOnDegraded: false, version: '9.9.9' },
      },
    };
  }
}
