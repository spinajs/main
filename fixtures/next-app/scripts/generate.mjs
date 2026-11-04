// Writes the generated client next to the app, with a copy of the built runtime, so Next bundles nothing from outside this folder.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateClientFiles } from '../../../packages/client/lib/index.js';
import { readManifest } from '../../../packages/manifest/lib/index.js';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const out = at('../generated/');
const runtime = at('../../../packages/client/lib/runtime/');

rmSync(out, { recursive: true, force: true });
mkdirSync(at('../generated/runtime/'), { recursive: true });
for (const file of readdirSync(runtime).filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'))) cpSync(runtime + file, at(`../generated/runtime/${file}`));

const manifest = await readManifest(at('../../../packages/compiler/test/fixtures/app-basic/app.manifest.json'));
const files = await generateClientFiles({ manifest, hooks: ['react-query'], next: true, includeSocket: false, moduleName: './runtime/index.js' });
for (const file of files) writeFileSync(out + file.path, file.contents);
console.log(`generated ${files.map((f) => f.path).join(', ')}`);
