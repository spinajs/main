import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '@spinajs/manifest';
import { ManifestDiff } from '../src/cli/ManifestDiff.js';

const fixture = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));

class Captured extends ManifestDiff {
  public output = '';
  protected override write(text: string): void {
    this.output += text;
  }
}

describe('manifest:diff', () => {
  let dir: string;
  let head: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spinajs-manifest-diff-'));
    head = join(dir, 'head.json');
    const manifest = JSON.parse(readFileSync(fixture, 'utf8')) as Manifest;
    manifest.controllers[0].routes = [];
    manifest.hash = 'a'.repeat(64);
    writeFileSync(head, JSON.stringify(manifest));
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('prints markdown by default', async () => {
    const cmd = new Captured();
    await cmd.execute(fixture, head, { format: 'markdown' });
    expect(cmd.output).to.include('**BREAKING**');
    expect(cmd.output).to.include('`GET /health/get`');
    expect(process.exitCode).to.equal(undefined);
  });

  it('prints the diff as json', async () => {
    const cmd = new Captured();
    await cmd.execute(fixture, head, { format: 'json' });
    const diff = JSON.parse(cmd.output) as { breaking: boolean; changes: { id: string }[] };
    expect(diff.breaking).to.equal(true);
    expect(diff.changes.map((c) => c.id)).to.include('GET /health/get');
  });

  it('sets a failing exit code with --fail-on breaking', async () => {
    await new Captured().execute(fixture, head, { format: 'markdown', failOn: 'breaking' });
    expect(process.exitCode).to.equal(1);
  });

  it('keeps a zero exit code when nothing is breaking', async () => {
    await new Captured().execute(fixture, fixture, { format: 'markdown', failOn: 'breaking' });
    expect(process.exitCode).to.equal(undefined);
  });
});
