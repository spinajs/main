import { expect } from 'chai';
import 'mocha';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as orm from '../src/index.js';

const SNAPSHOT = fileURLToPath(new URL('./exports.snapshot.json', import.meta.url));

describe('@spinajs/orm runtime exports', () => {
  it('match test/exports.snapshot.json', () => {
    const actual = Object.keys(orm).sort();
    if (process.env.UPDATE_EXPORTS_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as string[];
    expect(actual).to.deep.equal(expected);
  });
});
