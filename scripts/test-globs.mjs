import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * npm runs a script through `sh` on Linux, where `**` acts as `*`. When the shell finds a match it hands mocha only
 * the files one directory deep and the suite looks green having run a fraction of itself; Windows never shows it.
 */
export function unquotedGlobs(scripts = {}) {
  const found = [];
  for (const [name, script] of Object.entries(scripts)) {
    const outsideQuotes = script.replace(/"[^"]*"|'[^']*'/g, '');
    for (const token of outsideQuotes.split(/\s+/)) {
      if (token.includes('**')) found.push(`${name}: ${token}`);
    }
  }
  return found;
}

/** A mocharc spec that matches nothing only prints a warning, and leaves the suite to whatever the script passes. */
export function staleSpecs(dir) {
  const file = join(dir, '.mocharc.json');
  if (!existsSync(file)) return [];
  const specs = [JSON.parse(readFileSync(file, 'utf8')).spec ?? []].flat();
  return specs.filter((spec) => globSync(spec, { cwd: dir }).length === 0);
}

export function testGlobProblems(dir, pkg) {
  return [
    ...unquotedGlobs(pkg.scripts).map((s) => `unquoted glob in script ${s}: sh narrows it on Linux, wrap it in double quotes`),
    ...staleSpecs(dir).map((s) => `.mocharc.json spec ${s} matches no file`),
  ];
}
