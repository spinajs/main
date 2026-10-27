import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));
