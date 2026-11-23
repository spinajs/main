import * as fc from 'fast-check';
import type { DecisionRecord, ReplayReport } from '@spinajs/authz';

/** One generated scenario on a real stack: its decisions, the writes that follow them, and the replay of the records. */
export interface ReplayAgreementRun {
  /** Makes the scenario's decisions through the real engine; resolves with every record the decision log stored. */
  decide(): Promise<readonly DecisionRecord[]>;
  /** The scenario's later writes through the stores, strictly after every decision and outside its ambiguity window. */
  write(): Promise<void>;
  replay(decisionId: string): Promise<ReplayReport | undefined>;
  dispose?(): Promise<void>;
}

export interface ReplayAgreementFixture<T> {
  readonly scenarios: fc.Arbitrary<T>;
  open(scenario: T, options: { readonly captureInputs: boolean }): Promise<ReplayAgreementRun>;
}

export interface ReplayAgreementOptions<T> {
  readonly fixture: ReplayAgreementFixture<T>;
  /** Default `AUTHZ_REPLAY_AGREEMENT_RUNS`, else 200. */
  readonly runs?: number;
  /** Whether the decision log captures inputs; with them the evidence must be `inputs-hash`, without them `outcome`. Default false. */
  readonly captureInputs?: boolean;
  /** Replays a failure fast-check printed; default `AUTHZ_REPLAY_AGREEMENT_SEED`. */
  readonly seed?: number;
  /** With `seed`, the shrink path fast-check printed; default `AUTHZ_REPLAY_AGREEMENT_PATH`. */
  readonly path?: string;
}

const outcome = (allowed: boolean): 'allow' | 'deny' => (allowed ? 'allow' : 'deny');

/** Why the report of `record` is not a faithful replay of it, or undefined when it is. */
export function replayDisagreement(record: DecisionRecord, report: ReplayReport | undefined, captureInputs: boolean): string | undefined {
  if (report === undefined) return 'the replay found no record';
  const evidence = captureInputs ? 'inputs-hash' : 'outcome';
  if (report.replay !== 'faithful') return `the replay is ${report.replay}`;
  if (report.outcome.replayed !== outcome(record.allowed)) return `the record says ${outcome(record.allowed)}, the replay ${String(report.outcome.replayed)}`;
  if (report.evidence !== evidence) return `the evidence is ${String(report.evidence)}, not ${evidence}`;
  return undefined;
}

/**
 * Replay conformance (P4): for every generated scenario, every decision the real engine logged replays `faithful`
 * after the later writes, with the replayed truth equal to the recorded outcome. A failure names the record and its
 * report; fast-check adds the scenario and the seed that replays it.
 */
export async function replayAgreement<T>(options: ReplayAgreementOptions<T>): Promise<void> {
  const numRuns = options.runs ?? replayAgreementRuns();
  const captureInputs = options.captureInputs ?? false;
  const { fixture } = options;
  const envSeed = process.env.AUTHZ_REPLAY_AGREEMENT_SEED;
  const seed = options.seed ?? (envSeed === undefined || envSeed === '' ? undefined : Number(envSeed));
  const path = options.path ?? (process.env.AUTHZ_REPLAY_AGREEMENT_PATH || undefined);
  await fc.assert(
    fc.asyncProperty(fixture.scenarios, async (scenario) => {
      const run = await fixture.open(scenario, { captureInputs });
      try {
        const records = [...(await run.decide())];
        if (records.length === 0) throw new Error('the scenario logged no decision');
        // Instants have millisecond resolution: a write in the millisecond of a decision would be part of its replay.
        const lastLogged = Math.max(...records.map((record) => Date.parse(record.loggedAt ?? record.at)));
        while (Date.now() === lastLogged) await new Promise((resolve) => setTimeout(resolve, 1));
        const writesStart = Date.now();
        await run.write();
        for (const record of records) {
          const logged = Date.parse(record.loggedAt ?? record.at);
          if (!(logged < writesStart)) throw new Error(`decision ${record.id} was logged after the later writes started (${record.loggedAt ?? record.at} >= ${new Date(writesStart).toISOString()})`);
        }
        for (const record of records) {
          const report = await run.replay(record.id);
          const wrong = replayDisagreement(record, report, captureInputs);
          if (wrong !== undefined) throw new Error(`decision ${record.id} (${record.principal} ${record.permission} on ${JSON.stringify(record.resource)}): ${wrong}\nreport: ${JSON.stringify(report, null, 2)}`);
        }
      } finally {
        await run.dispose?.();
      }
    }),
    { numRuns, ...(seed === undefined ? {} : { seed }), ...(seed === undefined || path === undefined ? {} : { path }) },
  );
}

/** `AUTHZ_REPLAY_AGREEMENT_RUNS`, else 200: the count `replayAgreement` runs without `runs`. */
export function replayAgreementRuns(): number {
  return Number(process.env.AUTHZ_REPLAY_AGREEMENT_RUNS) || 200;
}
