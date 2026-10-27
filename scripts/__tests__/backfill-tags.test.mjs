import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseReleaseCommits, backfillTags } from '../backfill-tags.mjs';

test('parseReleaseCommits extracts release commits only', () => {
  const log = [
    'aaa111 release v3.0.23 [skip ci]',
    'bbb222 fix(http): something',
    'ccc333 release v3.0.22 [skip ci]',
    'ddd444 release v3.0.21',
    'eee555 chore: mention release v3.0.20 [skip ci] in text',
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseCommits(log), [
    { sha: 'aaa111', version: '3.0.23' },
    { sha: 'ccc333', version: '3.0.22' },
  ]);
});

test('parseReleaseCommits handles CRLF and empty input', () => {
  assert.deepEqual(parseReleaseCommits(''), []);
  assert.deepEqual(parseReleaseCommits('abc release v1.2.3 [skip ci]\r\n'), [{ sha: 'abc', version: '1.2.3' }]);
});

test('backfillTags creates missing annotated tags in a throwaway repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-tags-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    git('config', 'commit.gpgsign', 'false');
    const commit = (msg) => {
      writeFileSync(join(dir, 'f'), msg);
      git('add', '-A');
      git('commit', '-q', '-m', msg);
      return git('rev-parse', 'HEAD');
    };
    const sha1 = commit('release v3.0.1 [skip ci]');
    commit('feat: x');
    const sha2 = commit('release v3.0.2 [skip ci]');
    commit('release v2.0.9 [skip ci]');
    git('tag', '-a', 'v3.0.2', '-m', 'existing', sha2);

    const dry = backfillTags({ cwd: dir, dryRun: true, minMajor: 3 });
    assert.deepEqual(dry.map((t) => t.tag), ['v3.0.1']);
    assert.equal(git('tag', '-l'), 'v3.0.2');

    backfillTags({ cwd: dir, minMajor: 3 });
    assert.equal(git('rev-parse', 'v3.0.1^{commit}'), sha1);
    assert.equal(git('cat-file', '-t', 'v3.0.1'), 'tag');
    assert.equal(git('tag', '-l', 'v2*'), '');
    assert.deepEqual(backfillTags({ cwd: dir, minMajor: 3 }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
