/**
 * Mocha --require hook for `mocha --dry-run`: records where each test is declared, so remove-tests.mjs
 * can delete a row from the table a loop builds tests from. Writes { [fullTitle]: { file, line, index,
 * suite } } to TEST_SITES_OUT, where index counts the tests declared earlier at the same file and line
 * ( the loop iteration ) and suite is the enclosing describe's full title.
 */
'use strict';

const { writeFileSync } = require('fs');
const { relative } = require('path');
const Suite = require(require.resolve('mocha/lib/suite', { paths: [process.cwd()] }));

// Stack lines of the .ts source, not of what ts-node compiled it to.
process.setSourceMapsEnabled(true);

const sites = {};
const seen = new Map();
const addTest = Suite.prototype.addTest;
Suite.prototype.addTest = function (test) {
  const frame = new Error().stack
    .split('\n')
    .map((l) => /(?:file:\/+)?((?:[A-Za-z]:)?[\\/][^():]+\.test\.ts):(\d+):\d+/.exec(l))
    .find(Boolean);
  const result = addTest.call(this, test);
  if (frame) {
    const file = relative(process.cwd(), decodeURIComponent(frame[1])).replaceAll('\\', '/');
    const line = Number(frame[2]);
    const key = `${file}:${line}`;
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    sites[test.fullTitle()] = { file, line, index, suite: test.parent?.fullTitle() ?? '' };
  }
  return result;
};

process.on('exit', () => writeFileSync(process.env.TEST_SITES_OUT, JSON.stringify(sites, null, 1)));
