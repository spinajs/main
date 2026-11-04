import { TERMINAL_STATUSES } from './contract.js';
import type { WorkflowRegistry } from './registry.js';
import type { MissingVersion } from './service.js';
import { quoter, selectRows, workflowDriver } from './sql.js';

/** D5: unfinished instances whose workflow version no registered class provides; the engine never touches them. */
export async function missingVersions(registry: WorkflowRegistry): Promise<MissingVersion[]> {
  const driver = await workflowDriver();
  const q = quoter(driver);
  const rows = await selectRows<{ wf: string; ver: number | string; n: number | string }>(
    driver,
    `SELECT ${q('Workflow')} AS wf, ${q('Version')} AS ver, COUNT(*) AS n FROM ${q('__workflow')} WHERE ${q('Status')} NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')}) GROUP BY ${q('Workflow')}, ${q('Version')}`,
    [...TERMINAL_STATUSES],
  );
  return rows
    .map((r) => ({ workflow: r.wf, version: Number(r.ver), instances: Number(r.n) }))
    .filter((m) => !registry.find(m.workflow, m.version))
    .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.version - b.version);
}
