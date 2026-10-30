// Lists a directory through the built @spinajs/reflection while glob cannot be resolved from it, and prints the error.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

const LIB = `${resolve(process.cwd(), 'lib')}${sep}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    // @spinajs/configuration imports glob too; only reflection's own import goes missing
    if (/^glob(\/|$)/.test(specifier) && context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL).startsWith(LIB)) {
      throw Object.assign(new Error(`Cannot find package '${specifier}' imported from ${context.parentURL}`), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return nextResolve(specifier, context);
  },
});

const { createTestApp } = await import('@spinajs/testing');
const { ListFromFiles } = await import('@spinajs/reflection');

const app = await createTestApp({
  config: {
    system: { dirs: { scanned: [join(process.cwd(), 'test', 'test-services', 'singletons')] } },
    logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
  },
});

class Holder {}
ListFromFiles('/**/*.{ts,js}', 'system.dirs.scanned')(Holder.prototype, 'listed');

const result = {};
try {
  result.listed = (await new Holder().listed).length;
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message) };
} finally {
  await app.dispose();
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
