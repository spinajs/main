// Imports the built @spinajs/reflection, then its ./typescript subpath, and prints which modules imported typescript or glob.
import { registerHooks } from 'node:module';

const imports = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(typescript|glob)(\/|$)/.test(specifier)) imports.push({ specifier, parent: context.parentURL ?? '' });
    return nextResolve(specifier, context);
  },
});

await import('@spinajs/reflection');
const root = [...imports];
const { TypescriptCompiler } = await import('@spinajs/reflection/typescript');
const subpath = imports.slice(root.length);

console.log(`<<JSON\n${JSON.stringify({ root, subpath, compiler: typeof TypescriptCompiler })}\nJSON>>`);
