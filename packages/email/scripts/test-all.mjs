// Runs both suites even when the first fails (it has known network-bound failures), and fails if either fails.
import { spawnSync } from 'node:child_process';

const runs = ['test/*.test.ts', '--config .mocharc.authz.json'].map((args) => spawnSync(`ts-mocha -p tsconfig.json ${args}`, { stdio: 'inherit', shell: true }).status);
process.exit(runs.some((status) => status !== 0) ? 1 : 0);
