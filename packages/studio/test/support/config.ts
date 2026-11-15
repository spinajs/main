import os from 'node:os';
import { join, normalize, resolve } from 'node:path';
import express from 'express';

import fragment from '../../src/config/studio.js';

const cache = resolve(process.cwd(), 'test', 'cache');
const httpSrc = (path: string) => resolve(normalize(join(process.cwd(), '..', 'http', 'src', path)));

/** Root permissions every Studio test registers: the fragment's two and authz:explain, which the app declares. */
export const ROOT_PERMISSIONS = { ...structuredClone(fragment.authz.permissions), 'authz:explain': {} };

/**
 * The configuration every Studio test app boots with: Studio enabled, checks active. The in-memory
 * configuration applies no schema defaults, so every key Studio reads is spelled out.
 */
export function testConfig(): Record<string, unknown> {
  return {
    configuration: { isDevelopment: false, isProduction: false },
    system: {
      dirs: {
        // http's error pages render `__()`, so the intl locales must be present or they render as a 500.
        locales: [httpSrc('locales')],
        controllers: [],
      },
    },
    intl: { locales: ['en'], defaultLocale: 'en', queryParameter: 'lang' },
    fs: {
      defaultProvider: 'fs-temp',
      providers: [
        { service: 'fsNative', name: 'fs-temp', basePath: cache },
        { service: 'fsNative', name: '__file_upload_default_provider__', basePath: os.tmpdir() },
        { service: 'fsNative', name: '__fs_controller_cache__', basePath: cache },
        { service: 'fsNative', name: '__fs_http_response_templates__', basePath: httpSrc(join('views', 'responses')) },
        { service: 'fsNative', name: '__fs_http_templates__', basePath: cache },
      ],
    },
    logger: {
      targets: [{ name: 'Empty', type: 'ConsoleTarget' }],
      rules: [{ name: '*', level: 'error', target: 'Empty' }],
    },
    http: {
      port: 0,
      cookie: { secret: 'studio-test-cookie-secret' },
      middlewares: [express.json({ limit: '5mb' })],
      AcceptHeaders: 1 | 2,
    },
    authz: {
      ...structuredClone(fragment.authz),
      permissions: structuredClone(ROOT_PERMISSIONS),
      combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } },
      cache: { maxEntries: 0 },
      http: { services: [], explainRoute: { enabled: false, permission: 'authz:explain' }, links: { query: 'link', header: 'X-Authz-Link', cookie: null }, access: { domain: 'root' }, admin: { domain: 'root' } },
      principals: { anonymous: { enabled: true } },
    },
    studio: { ...structuredClone(fragment.studio), enabled: true },
  };
}
