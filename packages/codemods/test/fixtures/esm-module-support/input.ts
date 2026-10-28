import { DI } from '@spinajs/di';
import { join } from 'path';

DI.setESMModuleSupport();

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return join(process.cwd(), 'node_modules', '@spinajs', 'cli', 'lib', inCommonJs ? 'cjs' : 'mjs', path);
}

export default { dir: dir('cli') };
