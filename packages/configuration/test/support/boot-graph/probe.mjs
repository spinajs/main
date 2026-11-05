// Boots the built @spinajs/configuration with its file sources from a temporary app in the mode given as argv[2], and
// prints a few loaded values and every bare package specifier resolved on the way, by `import` or `require`.
import * as nodeModule from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof nodeModule.registerHooks !== 'function') {
  console.log(`<<JSON\n${JSON.stringify({ unsupported: `module.registerHooks is missing in Node ${process.version}; this probe needs Node >= 22.15` })}\nJSON>>`);
  process.exit(0);
}

const packages = new Set();
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const bare = /^(@[^/]+\/[^/]+|[^./][^/:]*)(\/|$)/.exec(specifier);
    if (bare && !specifier.startsWith('node:')) packages.add(bare[1]);
    return nextResolve(specifier, context);
  },
});

const mode = process.argv[2];
const app = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-config-probe-')));
const write = (file, content) => {
  mkdirSync(dirname(join(app, file)), { recursive: true });
  writeFileSync(join(app, file), typeof content === 'string' ? content : JSON.stringify(content));
};

const home = process.cwd();
const result = {};
try {
  const { hashManifest } = await import('@spinajs/manifest');
  const { DI } = await import('@spinajs/di');
  const { Configuration, ConfigurationSource } = await import('@spinajs/configuration-common');
  const { FrameworkConfiguration, JsFileSource, JsonFileSource, ManifestConfigurationSource } = await import('@spinajs/configuration');

  write('package.json', { name: 'probe-app', version: '0.0.0', type: 'module', workspaces: [] });
  write('node_modules/@spinajs/dep/package.json', { name: '@spinajs/dep', version: '0.0.0', type: 'module' });
  write('node_modules/@spinajs/dep/lib/config/dep.js', "export default { dep: { value: 'package', list: ['package'] } };");
  write('node_modules/@spinajs/dep/lib/config/nested/dep-extra.js', 'export default { depExtra: { loaded: true } };');
  write('lib/config/app.js', "export default { dep: { value: 'app' } };");
  write('lib/config/app.test.js', 'export default { app: { env: true } };');
  write('config/app.json', { json: { loaded: true } });

  const fixture = fileURLToPath(new URL('../../fixtures/parity-app/app.manifest.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(fixture, 'utf8'));
  manifest.app = { ...manifest.app, name: 'probe-app', root: app };
  manifest.packages = [{ name: '@spinajs/dep', version: '0.0.0', entry: 'lib/index.js', fragment: 'lib/manifest.fragment.json', outDir: 'lib', configFiles: ['config/dep.js', 'config/nested/dep-extra.js'] }];
  manifest.hash = hashManifest(manifest);
  write('app.manifest.json', manifest);

  process.chdir(app);
  process.env.WORKSPACE_ROOT_PATH = app;
  const container = DI.RootContainer.child({ isolateSingletons: true });
  container.register({ ...process.env, SPINAJS_MANIFEST_MODE: mode, APP_ENV: 'test' }).asValue('process.env');
  container.register(ManifestConfigurationSource).as(ConfigurationSource);
  container.register(JsFileSource).as(ConfigurationSource);
  container.register(JsonFileSource).as(ConfigurationSource);
  container.register(FrameworkConfiguration).as(Configuration, { replace: true });
  const config = await container.resolve(Configuration);
  result.values = { dep: { value: config.get('dep.value'), list: config.get('dep.list') }, depExtra: config.get('depExtra.loaded'), app: config.get('app.env'), json: config.get('json.loaded') };
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message) };
} finally {
  process.chdir(home);
  rmSync(app, { recursive: true, force: true });
}

result.packages = [...packages].sort();
console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
