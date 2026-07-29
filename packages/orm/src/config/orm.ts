import { join, normalize, resolve } from 'path';

/**
 * Migration directories are the APPLICATION's, not this package's - `@spinajs/orm` ships no
 * migrations of its own. So these resolve off the process working directory, matching the default
 * `@spinajs/orm-cli`'s `migrate-create` writes to.
 *
 * All three build layouts are listed because a project is scanned wherever it happens to have been
 * compiled to. A migration found in more than one of them is the same class name twice and is
 * deduped by `Orm`; the `src` copy of a compiled project fails to import and is warned about.
 */
function dir(...parts: string[]) {
  return resolve(normalize(join(process.cwd(), ...parts)));
}

const orm = {
  system: {
    dirs: {
      migrations: [dir('src', 'migrations'), dir('lib', 'migrations'), dir('dist', 'migrations')],
    },
  },
};

export default orm;
