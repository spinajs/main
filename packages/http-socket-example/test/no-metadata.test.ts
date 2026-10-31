import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';
import { buildAppManifest } from '@spinajs/compiler';

const ROOT = process.cwd();
const TSCONFIG = resolve(ROOT, 'tsconfig.no-metadata.json');
const MANIFEST = resolve(ROOT, 'lib', 'no-metadata', 'app.manifest.json');

function compileWithoutMetadata(): void {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
  if (!parsed) throw new Error(`cannot read ${TSCONFIG}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const { diagnostics } = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...diagnostics].filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
}

interface ProbeResult {
  opened?: { docId: string; version: number; openedBy: string };
  edited?: { version: number };
  invalid?: { code: string };
  error?: { name: string; message: string };
}

describe('notes example without emitDecoratorMetadata', function () {
  this.timeout(180000);

  let result: ProbeResult;

  before(async () => {
    compileWithoutMetadata();
    await buildAppManifest({ tsconfig: TSCONFIG, appRoot: ROOT, out: MANIFEST });

    const run = spawnSync(process.execPath, [resolve(ROOT, 'test', 'support', 'no-metadata-probe.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, SPINAJS_MANIFEST: MANIFEST, SPINAJS_MANIFEST_MODE: 'require' },
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`);
    result = JSON.parse(match[1]) as ProbeResult;
  });

  it('compiles without design:paramtypes', () => {
    expect(ts.sys.readFile(resolve(ROOT, 'lib', 'no-metadata', 'notes.socket.js'))).to.not.include('design:');
  });

  it('boots in require mode and answers socket commands with @Autoinject() properties typed by the manifest', () => {
    expect(result.error).to.equal(undefined);
    expect(result.opened).to.deep.equal({ docId: 'meta', version: 1, chunks: 20, openedBy: 'alice' });
    expect(result.edited).to.deep.equal({ version: 2 });
  });

  it('still validates the command payload', () => {
    expect(result.invalid).to.deep.equal({ code: 'invalid_argument' });
  });
});
