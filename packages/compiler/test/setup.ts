import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(pkgRoot);

const link = join(pkgRoot, 'test/fixtures/app-basic/node_modules/pkg-basic');
if (!existsSync(link)) {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(join(pkgRoot, 'test/fixtures/pkg-basic'), link, 'junction');
}
