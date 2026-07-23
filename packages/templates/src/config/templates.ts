import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'templates', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'templates', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const templates = {
  system: {
    dirs: {
      cli: [...dir('cli')],
    },
  },
  templates: {
    cache: {
      // How aggressively compiled templates are reused. Accepts:
      //   'cache'      - compile once, reuse forever.
      //   'revalidate' - stat() the source and recompile only when it changes.
      //   'always'     - recompile on every render.
      // Intentionally left unset: when no mode is configured the renderer falls
      // back to 'always' in development and 'cache' in production (see
      // TemplateRenderer.CacheMode). Shipping a concrete value here would defeat
      // that dev/prod fallback.
      // mode: 'cache',
    },
  },
};

export default templates;
