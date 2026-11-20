// Required by every .mocharc.stryker.json. Stryker maps tests to mutants in its dry run and reruns only those tests per
// mutant, so a property test must draw the same cases on every run, and short run counts keep a covering test cheap.
import * as fc from 'fast-check';

fc.configureGlobal({ seed: 20261106 });
process.env.AUTHZ_CONFORMANCE_RUNS ??= '5';
process.env.AUTHZ_IR_AGREEMENT_RUNS ??= '50';
