import { DI } from '@spinajs/di';
import { WorkflowEngine } from '../../src/index.js';

/** One engine per replica id, like the scheduler's `@PerInstanceCheck` loops. */
export async function engine(replicaId = 'r1'): Promise<WorkflowEngine> {
  return await DI.resolve(WorkflowEngine, [{ replicaId }]);
}
