// Single-file esbuild bundle of the example that boots from app.manifest.json ( system.manifest.mode = 'require' ).
// Output in dist/bundle:
//   main.mjs                                  the app with every dependency inlined
//   app.manifest.json                         built from lib/ by the compiler
//   node_modules/<pkg>/package.json           marker only: the manifest runtime locates a listed package by it
//   node_modules/<pkg>/<outDir>/config/*.js   package config files; the configuration source imports them by path
// Controller, socket controller, schedule and migration files the manifest lists are inlined into main.mjs and served
// to the runtime's import-by-path through the DI module loader, so they stay the same module instances as the app's.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildAppManifest } from '@spinajs/compiler';
import { manifestFileFor } from '@spinajs/manifest';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PACKAGE, 'dist', 'bundle');
// commands are CLI-only and would drag the compiler into a server bundle
const LOADED_SECTIONS = ['controllers', 'socketControllers', 'schedules', 'migrations'];

const COMMON = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // DI and reflection key services and manifest entries by class name
  keepNames: true,
  logLevel: 'warning',
  banner: { js: "import { createRequire as __spinajsCreateRequire } from 'node:module'; const require = __spinajsCreateRequire(import.meta.url);" },
};

// http and reflection import the compiler API for runtime type discovery. With a manifest it is never called, and it is 9 MB.
const typescriptStub = {
  name: 'typescript-stub',
  setup(b) {
    b.onResolve({ filter: /^typescript$/ }, () => ({ path: 'typescript', namespace: 'typescript-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'typescript-stub' }, () => ({
      loader: 'js',
      contents: `export default new Proxy({}, { get(_, key) { throw new Error(\`typescript is not part of this bundle ( ts.\${String(key)} ): run with system.manifest.mode=require\`); } });`,
    }));
  },
};

const entryOf = (pkg, outDir, file) => ({ source: { package: pkg, file: `${outDir}/${file}`, line: 1, col: 1 } });

async function main() {
  if (!existsSync(join(PACKAGE, 'lib', 'bundle.js'))) {
    throw new Error('lib/bundle.js is missing: compile the package first ( npm run compile )');
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { manifest } = await buildAppManifest({ tsconfig: join(PACKAGE, 'tsconfig.build.json'), appRoot: PACKAGE, out: join(OUT, 'app.manifest.json'), schemaDerivation: true });

  // The manifest runtime locates a listed package by its package.json and a direct dependency must be found, so the
  // markers have to exist before any path is resolved against the bundle root below.
  for (const pkg of manifest.packages) {
    writeFileSync(join(prepared(join(OUT, 'node_modules', pkg.name)), 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }));
  }

  const configEntries = [];
  for (const pkg of manifest.packages) {
    for (const file of pkg.configFiles ?? []) {
      const source = manifestFileFor(entryOf(pkg.name, pkg.outDir, file), manifest, PACKAGE);
      configEntries.push({ in: source, out: join('node_modules', pkg.name, pkg.outDir, file.replace(/\.[mc]?js$/, '')) });
    }
  }
  writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: manifest.app.name, version: manifest.app.version, type: 'module' }));

  // Package configs are separate module copies beside the bundle, not part of main.mjs: safe only while they are plain
  // data. A config file that imports stateful modules would get its own instance of them.
  await build({ ...COMMON, entryPoints: configEntries, outdir: OUT, outExtension: { '.js': '.js' } });

  const files = LOADED_SECTIONS.flatMap((section) => manifest[section]).map((entry) => ({ entry, from: manifestFileFor(entry, manifest, PACKAGE) }));
  // bundle-relative keys, resolved against the bundle root without touching the environment
  const rebased = { ...manifest, app: { ...manifest.app, root: OUT } };
  const keyOf = (file) => relative(OUT, file).split(sep).join('/');
  const listed = files.map(({ entry, from }) => ({ from, key: keyOf(manifestFileFor(entry, rebased, OUT)) }));
  const onDisk = configEntries.map((c) => `${c.out.split(sep).join('/')}.js`);
  const unique = [...new Map(listed.map((l) => [l.key, l])).values()];

  const contents = `
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { DI } from '@spinajs/di';
${unique.map((l, i) => `import * as listed${i} from ${JSON.stringify(l.from.split(sep).join('/'))};`).join('\n')}
import { startBundle } from ${JSON.stringify(join(PACKAGE, 'lib', 'bundle.js').split(sep).join('/'))};

const root = dirname(fileURLToPath(import.meta.url));
process.env.SPINAJS_MANIFEST_ROOT ??= root;
process.env.SPINAJS_MANIFEST ??= join(root, 'app.manifest.json');
process.env.SPINAJS_MANIFEST_MODE ??= 'require';

const onDisk = new Set(${JSON.stringify(onDisk)});
const listed = { ${unique.map((l, i) => `${JSON.stringify(l.key)}: listed${i}`).join(', ')} };
DI.register({
  async load(file) {
    const key = relative(root, file).split(sep).join('/');
    const found = listed[key];
    // a file under the root that is neither inlined nor a bundled config would load as a second module instance
    if (!found && !key.startsWith('..') && !onDisk.has(key)) throw new Error(\`\${file} is not part of this bundle\`);
    const loaded = found ?? (await import(pathToFileURL(file).href));
    return loaded.default ?? loaded;
  },
}).asValue('__module_loader__');

await startBundle();
`;

  await build({ ...COMMON, stdin: { contents, resolveDir: PACKAGE, sourcefile: 'bundle-entry.js' }, outfile: join(OUT, 'main.mjs'), plugins: [typescriptStub] });
  console.log(`bundle written to ${OUT}`);
}

function prepared(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

await main();
