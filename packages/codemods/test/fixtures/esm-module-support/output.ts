import { DI } from '@spinajs/di';
import { join } from 'path';

function dir(path: string) {
  return join(process.cwd(), 'node_modules', '@spinajs', 'cli', 'lib', path);
}

export default { dir: dir('cli') };
