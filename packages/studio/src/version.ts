import { readFileSync } from 'node:fs';

// One level up from both src/ (tests) and lib/ (built).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const STUDIO_VERSION: string = pkg.version;
