// Runs in a fresh node process (ts-node/esm): boots http-swagger with its own package config resolved under
// WORKSPACE_ROOT_PATH (set by the caller to a folder without swagger-ui-dist), `http.swagger.enabled`, the UI urls
// and an optional app entry for /docs/ui from argv, and prints what /docs/ui answers. Log lines go to the same stdout.
import 'reflect-metadata';
import { join } from 'node:path';
import { req, srcDir } from '../common.js';
import { bootWithPackageConfig } from './package-config-boot.js';

const enabled = process.argv[2] === 'enabled';
const cdn = process.argv[3] === 'cdn';
const appEntry = process.argv[4] === 'app';

const CDN = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5';
const ui = cdn
  ? { cssUrl: `${CDN}/swagger-ui.css`, bundleUrl: `${CDN}/swagger-ui-bundle.js`, presetUrl: `${CDN}/swagger-ui-standalone-preset.js` }
  : { cssUrl: '/docs/ui/swagger-ui.css', bundleUrl: '/docs/ui/swagger-ui-bundle.js', presetUrl: '/docs/ui/swagger-ui-standalone-preset.js' };

await bootWithPackageConfig((pkg, http) => ({
  ...pkg,
  ...http,
  Static: [
    // Only swagger-ui-dist is missing: the views folder of the package is where an install has it.
    ...pkg.Static.map((s) => (s.Route === '/docs/static' ? { ...s, Path: srcDir('views') } : s)),
    // An app that ships the UI files itself adds its own entry; config arrays concatenate, so the package's stays.
    ...(appEntry ? [{ Route: '/docs/ui', Path: srcDir('views') }] : []),
  ],
  swagger: { ...pkg.swagger, ...http.swagger, enabled, ui: { ...(http.swagger.ui as object), ...ui } },
}));

const uiDist = (await req().get('docs/ui/swagger-ui.css').set('Accept', 'text/css,*/*;q=0.1').send()).status;

process.stdout.write(`<<JSON\n${JSON.stringify({ uiDist, looked: join(process.env.WORKSPACE_ROOT_PATH ?? '', 'node_modules', 'swagger-ui-dist') })}\nJSON>>\n`);
process.exit(0);
