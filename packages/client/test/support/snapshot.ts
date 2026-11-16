import { expect } from 'chai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Compares with a committed file. A missing file fails, unless UPDATE_SNAPSHOTS is set, which writes it. */
export function matchesSnapshot(path: string, contents: string): void {
  if (!existsSync(path)) {
    if (!process.env.UPDATE_SNAPSHOTS) expect.fail(`snapshot ${path} is missing; run with UPDATE_SNAPSHOTS=1 to write it`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(contents).to.equal(readFileSync(path, 'utf8'));
}
