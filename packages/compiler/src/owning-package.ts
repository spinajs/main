import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface OwningPackage {
  name: string;
  root: string;
  /** `package.json#spinajs.manifest`: the package ships a manifest fragment */
  fragment?: string;
}

/** The nearest `package.json` with a name above `file`. */
export function owningPackage(file: string): OwningPackage | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const path = join(dir, 'package.json');
    if (existsSync(path)) {
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; spinajs?: { manifest?: string } };
      if (pkg.name) return { name: pkg.name, root: dir, fragment: pkg.spinajs?.manifest };
    }
    if (dirname(dir) === dir) return undefined;
  }
}
