import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(pkgRoot);

const link = join(pkgRoot, 'test/fixtures/app-basic/node_modules/pkg-basic');
const isLink = (): boolean => {
  try {
    return lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
};
if (isLink() && !existsSync(link)) rmSync(link, { force: true });
if (!isLink() && !existsSync(link)) {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(pkgRoot, 'test/fixtures/pkg-basic'), link, 'junction');
}
