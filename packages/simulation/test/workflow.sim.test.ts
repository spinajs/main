import 'mocha';
import { expect } from 'chai';
import { InvariantViolation, runSuite } from '../src/index.js';
import { workflowSuite, type WorkflowTamper } from '../suites/workflow.sim.js';

/** Each entry breaks one thing behind the engine's back; the named invariant must be the one that reports it. */
const SELF_TESTS: Array<{ tamper: WorkflowTamper; invariant: string; failRate: number }> = [
  { tamper: 'result', invariant: 'step-results-never-overwritten', failRate: 0.3 },
  { tamper: 'call', invariant: 'journal-branches-consistent', failRate: 0.3 },
  { tamper: 'drift', invariant: 'no-instance-failed', failRate: 0.3 },
  { tamper: 'compensation-order', invariant: 'compensations-newest-first', failRate: 1 },
  { tamper: 'compensation-effect', invariant: 'compensation-effects-at-least-once', failRate: 1 },
  { tamper: 'effect', invariant: 'transactional-effects-match-journal', failRate: 0 },
  { tamper: 'consume', invariant: 'signal-consumed-once-per-wait', failRate: 0.3 },
  { tamper: 'stall', invariant: 'every-instance-terminal', failRate: 0.3 },
  { tamper: 'status', invariant: 'outcome-matches-input', failRate: 1 },
];

describe('workflow suite', function () {
  this.timeout(0);

  it('reaches workflow.after-step-fn and survives a crash there', async () => {
    const report = await runSuite(workflowSuite({ faults: [{ point: 'workflow.after-step-fn', when: { nth: 1 }, effect: 'crash' }] }), 3, 120);
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point)).to.deep.equal(['workflow.after-step-fn']);
  });

  it('reaches the journal fault points', async () => {
    const report = await runSuite(
      workflowSuite({
        faults: [
          { point: 'workflow.before-journal', when: { nth: 1 }, effect: 'crash' },
          { point: 'workflow.after-journal', when: { nth: 2 }, effect: 'crash' },
        ],
      }),
      4,
      120,
    );
    expect(report.failure).to.equal(undefined);
    expect(report.faults.map((h) => h.point).sort()).to.deep.equal(['workflow.after-journal', 'workflow.before-journal']);
  });

  for (const t of SELF_TESTS) {
    it(`self-test ${t.tamper}: ${t.invariant} reports it`, async () => {
      const report = await runSuite(workflowSuite({ tamper: t.tamper, failRate: t.failRate, faults: [] }), 3, 80);
      expect(report.failure?.invariant).to.equal(t.invariant);
      // the invariant's own check fired, not an error thrown while it read the tables
      expect(report.failure?.error).to.be.instanceOf(InvariantViolation);
    });
  }
});
