import * as chai from 'chai';
import 'mocha';
import * as path from 'node:path';
import { MIGRATION_DI_SOURCE, OrmException, mergeMigrationEnv, parseMigrationFileEnv, resolveMigrationEnv } from '../src/index.js';

const expect = chai.expect;

const p = (...parts: string[]) => path.join('C:', 'app', 'src', 'migrations', ...parts);

describe('parseMigrationFileEnv', () => {
  it('returns undefined for an unsuffixed file', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.ts'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.js'))).to.equal(undefined);
  });

  it('returns the tag of a suffixed file', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.local.ts'))).to.equal('local');
  });

  it('normalizes the tag', () => {
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.development.ts'))).to.equal('dev');
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.production.js'))).to.equal('prod');
  });

  it('is not confused by dots in the directories above it', () => {
    expect(parseMigrationFileEnv(path.join('C:', 'my.app', 'v1.2', 'Foo_2026_07_29_10_00_00.ts'))).to.equal(undefined);
  });

  it('returns undefined for the DI sentinel', () => {
    expect(parseMigrationFileEnv(MIGRATION_DI_SOURCE)).to.equal(undefined);
  });

  it('refuses more than one tag', () => {
    expect(() => parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.local.dev.ts'))).to.throw(OrmException, /one environment/);
  });

  it('rejects empty middle segment (malformed filename)', () => {
    expect(() => parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00..ts'))).to.throw(OrmException, /Foo_2026_07_29_10_00_00\.\.ts/);
  });

  it('returns undefined for a test suite that declares a migration inline, without a blocklist', () => {
    expect(parseMigrationFileEnv(p('migration.test.ts'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('migration.spec.ts'))).to.equal(undefined);
  });

  it('treats a stamped .test.ts / .spec.ts as unsuffixed - the anchor alone does not reject these', () => {
    // 'Foo_2026_07_29_10_00_00' carries the timestamp stamp, so the anchor check passes it
    // through unchanged: without the carve-out below, this would misread as environment 'test'.
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.test.ts'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.spec.ts'))).to.equal(undefined);
  });

  it('treats stamped .test.js / .spec.js as unsuffixed - compiled test artifacts', () => {
    // `.test.js` and `.spec.js` are compiled artifacts of test suites, not migration files
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.test.js'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.spec.js'))).to.equal(undefined);
  });

  it('treats .d.ts as unsuffixed but reads .d.js as environment d', () => {
    // `.d.ts` is a TypeScript declaration file convention, carved out for `.ts` only
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.d.ts'))).to.equal(undefined);
    // `.d.js` is not a declaration-file convention (no such convention exists for `.js`),
    // so 'd' is a legitimate environment name
    expect(parseMigrationFileEnv(p('Foo_2026_07_29_10_00_00.d.js'))).to.equal('d');
  });

  it('returns undefined for any other dotted non-migration filename (no blocklist needed)', () => {
    expect(parseMigrationFileEnv(p('Bar.stories.ts'))).to.equal(undefined);
    expect(parseMigrationFileEnv(p('helper.mock.ts'))).to.equal(undefined);
  });
});

describe('resolveMigrationEnv', () => {
  it('takes the suffix when only the file carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.local.ts'), undefined)).to.equal('local');
  });

  it('takes the decorator when only it carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.ts'), 'local')).to.equal('local');
  });

  it('normalizes the decorator value', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', MIGRATION_DI_SOURCE, 'development')).to.equal('dev');
  });

  it('accepts agreement, including across aliases', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.dev.ts'), 'development')).to.equal('dev');
  });

  it('refuses disagreement, naming both sides', () => {
    const call = () => resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.local.ts'), 'dev');

    expect(call).to.throw(OrmException, /local/);
    expect(call).to.throw(OrmException, /dev/);
  });

  it('returns undefined when neither carries one', () => {
    expect(resolveMigrationEnv('Foo_2026_07_29_10_00_00', p('Foo_2026_07_29_10_00_00.ts'), undefined)).to.equal(undefined);
  });
});

describe('mergeMigrationEnv', () => {
  const entry = (env: string | undefined, file: string) => ({ env, file });

  it('lets a defined env win over an absent one, in either order', () => {
    expect(mergeMigrationEnv('Foo', entry(undefined, MIGRATION_DI_SOURCE), entry('local', p('Foo.local.ts')))).to.equal('local');
    expect(mergeMigrationEnv('Foo', entry('local', p('Foo.local.ts')), entry(undefined, MIGRATION_DI_SOURCE))).to.equal('local');
  });

  it('keeps an agreed env', () => {
    expect(mergeMigrationEnv('Foo', entry('local', p('a', 'Foo.local.ts')), entry('local', p('b', 'Foo.local.ts')))).to.equal('local');
  });

  it('keeps absent when neither side has one', () => {
    expect(mergeMigrationEnv('Foo', entry(undefined, p('Foo.ts')), entry(undefined, MIGRATION_DI_SOURCE))).to.equal(undefined);
  });

  it('refuses two different envs, naming both origins', () => {
    const call = () => mergeMigrationEnv('Foo', entry('local', p('src', 'Foo.local.ts')), entry('dev', p('lib', 'Foo.dev.js')));

    expect(call).to.throw(OrmException, /Foo\.local\.ts/);
    expect(call).to.throw(OrmException, /Foo\.dev\.js/);
  });
});
