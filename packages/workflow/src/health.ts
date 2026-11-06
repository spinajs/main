import type { WorkflowStatus } from './contract.js';
import type { WorkflowRegistry } from './registry.js';
import type { MissingVersion } from './service.js';
import { workflowDriver } from './sql.js';

// listed rather than NOT IN the terminal ones, so the (Status, WakeAt) index applies
const UNFINISHED: WorkflowStatus[] = ['running', 'sleeping', 'waiting', 'compensating'];

/** D5: unfinished instances whose workflow version no registered class provides; the engine never touches them. */
export async function missingVersions(registry: WorkflowRegistry): Promise<MissingVersion[]> {
  const driver = await workflowDriver();
  // count() first: it clears the selected columns
  const rows = (await driver
    .select()
    .from('__workflow')
    .count('Id', 'n')
    .select('Workflow')
    .select('Version')
    .whereIn('Status', UNFINISHED)
    .groupBy('Workflow')
    .groupBy('Version')) as Array<{ Workflow: string; Version: number | string; n: number | string }>;
  return rows
    .map((r) => ({ workflow: r.Workflow, version: Number(r.Version), instances: Number(r.n) }))
    .filter((m) => !registry.find(m.workflow, m.version))
    .sort((a, b) => a.workflow.localeCompare(b.workflow) || a.version - b.version);
}
