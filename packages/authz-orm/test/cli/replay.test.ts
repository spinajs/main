import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';
import { DecisionReplay, ReplayBusy } from '@spinajs/authz';
import type { ReplayOptions, ReplayReport } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { ReplayCommand } from '../../src/cli/commands/replay.js';

const expect = chai.expect;

const ID = '019a8e2c-6c1e-7a51-9f3e-2b1c4d5e6f70';

const report = (over: Partial<ReplayReport> = {}): ReplayReport => ({
  decision: { id: ID, at: '2026-11-17T10:00:00.000Z', domain: 'root', principal: 'user:alice', permission: 'doc:read', resource: { type: 'doc', id: '1' }, allowed: true, cached: false, policyHash: 'a'.repeat(64), modelVersions: {}, inputsHash: 'h' },
  currentPolicy: true,
  replay: 'faithful',
  evidence: 'outcome',
  outcome: { recorded: 'allow', replayed: 'allow' },
  inputsHash: { recorded: 'h', replayed: null },
  missing: [],
  divergence: [],
  tree: { label: 'doc:1#doc:read', truth: 'allow', source: 'union', children: [{ label: 'doc:1#parent', truth: 'allow', source: 'stored', children: [] }] },
  reads: [{ kind: 'column', key: 'doc:1#parent', origin: 'history', seq: 7 }],
  limits: { changes: 3, maxChanges: 50000, keys: 1, durationMs: 4 },
  ...over,
});

class StubReplay extends DecisionReplay {
  public answers: Array<() => Promise<ReplayReport | undefined>> = [];
  public options: Array<ReplayOptions | undefined> = [];

  public async replay(_id: string, options?: ReplayOptions): Promise<ReplayReport | undefined> {
    this.options.push(options);
    return (this.answers.shift() ?? (async () => report()))();
  }
}

describe('authz:replay', () => {
  const out: string[] = [];
  let replay: StubReplay;

  beforeEach(() => {
    out.length = 0;
    replay = new StubReplay();
  });
  afterEach(() => {
    sinon.restore();
    process.exitCode = undefined;
  });

  const run = async (opts: Record<string, unknown> = {}, id = ID) => {
    const cmd = Object.assign(new ReplayCommand(), { Container: DI.RootContainer, Replay: replay, RetryMs: 1 });
    sinon.stub(cmd as unknown as { prepare(): Promise<void> }, 'prepare').resolves();
    sinon.stub(cmd as unknown as { out(l: string): void }, 'out').callsFake((l: string) => void out.push(l));
    sinon.stub(cmd as unknown as { fail(l: string): void }, 'fail').callsFake((l: string) => {
      out.push(`FAIL ${l}`);
      process.exitCode = 1;
    });
    await cmd.execute(id, opts);
  };
  const failed = (text: string) => out.some((l) => l.startsWith('FAIL') && l.includes(text));

  it('text: the verdict, the outcome, the evidence and the tree, indented', async () => {
    await run();
    expect(out[0]).to.equal('faithful (evidence: outcome)');
    expect(out).to.include(`decision ${ID} at 2026-11-17T10:00:00.000Z in root: user:alice doc:read doc:1`);
    expect(out).to.include('outcome recorded allow, replayed allow');
    expect(out).to.include('  doc:1#doc:read = allow (union)');
    expect(out).to.include('    doc:1#parent = allow (stored)');
    expect(process.exitCode).to.equal(undefined);
  });

  it('text: lists what is missing and what diverged', async () => {
    replay.answers.push(async () => report({ replay: 'unreplayable', evidence: undefined, missing: [{ input: 'column', key: 'column:doc', reason: 'the column history starts nowhere' }], divergence: [{ part: 'outcome', recorded: 'allow', replayed: 'deny' }] }));
    await run({ failOn: 'never' });
    expect(out[0]).to.equal('unreplayable');
    expect(out).to.include('  column column:doc: the column history starts nowhere');
    expect(out).to.include('  outcome: recorded allow, replayed deny');
  });

  it('json: prints the report as JSON, nothing else on stdout', async () => {
    await run({ format: 'json' });
    expect(JSON.parse(out.join('\n'))).to.deep.equal(report());
  });

  it('exits 1 when the verdict is at or past --fail-on (default divergent)', async () => {
    const cases: Array<[ReplayReport['replay'], string | undefined, number | undefined]> = [
      ['faithful', undefined, undefined],
      ['divergent', undefined, 1],
      ['unreplayable', undefined, 1],
      ['divergent', 'unreplayable', undefined],
      ['unreplayable', 'unreplayable', 1],
      ['unreplayable', 'never', undefined],
    ];
    for (const [verdict, failOn, code] of cases) {
      process.exitCode = undefined;
      replay.answers.push(async () => report({ replay: verdict }));
      await run({ format: 'json', ...(failOn === undefined ? {} : { failOn }) });
      expect(process.exitCode, `${verdict} --fail-on ${failOn ?? 'divergent'}`).to.equal(code);
    }
  });

  it('an unknown id prints an error and exits 1', async () => {
    replay.answers.push(async () => undefined);
    await run();
    expect(failed(`no decision ${ID} in the decision log`)).to.equal(true);
    expect(process.exitCode).to.equal(1);
  });

  it('--max-changes is handed to the replay; a value that is not a positive integer is refused', async () => {
    await run({ maxChanges: '1200' });
    expect(replay.options[0]?.maxChanges).to.equal(1200);
    await run({ maxChanges: 'many' });
    expect(failed('--max-changes')).to.equal(true);
    expect(replay.options).to.have.length(1);
  });

  it('refuses an unknown --format or --fail-on', async () => {
    await run({ format: 'yaml' });
    expect(failed('--format')).to.equal(true);
    await run({ failOn: 'sometimes' });
    expect(failed('--fail-on')).to.equal(true);
    expect(replay.options).to.have.length(0);
  });

  it('waits while the replays of the process are busy', async () => {
    replay.answers.push(async () => Promise.reject(new ReplayBusy(2)));
    await run();
    expect(replay.options).to.have.length(2);
    expect(out[0]).to.equal('faithful (evidence: outcome)');
  });
});
