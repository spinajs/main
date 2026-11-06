import { NonRetryableError } from '@spinajs/durable';
import type { SerializedError } from './contract.js';
import { safeStringify } from './json.js';

export class WorkflowNotRegistered extends Error {
  constructor(workflow: string, version?: number) {
    super(version === undefined ? `workflow '${workflow}' is not registered` : `workflow '${workflow}' version ${version} is not registered`);
    this.name = 'WorkflowNotRegistered';
  }
}

export class WorkflowNotFound extends Error {
  constructor(public readonly instanceId: string) {
    super(`workflow instance '${instanceId}' does not exist`);
    this.name = 'WorkflowNotFound';
  }
}

export class WorkflowIdConflict extends Error {
  constructor(id: string, existing: string, requested: string) {
    super(`workflow instance '${id}' already exists as '${existing}', not '${requested}'`);
    this.name = 'WorkflowIdConflict';
  }
}

/** A start inside a transaction whose snapshot cannot see the instance a concurrent start committed under the same id. */
export class WorkflowStartConflict extends Error {
  constructor(public readonly instanceId: string) {
    super(`workflow instance '${instanceId}' was started concurrently and this transaction's snapshot cannot see it; retry the start in a new transaction or outside one`);
    this.name = 'WorkflowStartConflict';
  }
}

export class DuplicateWorkflowDefinition extends Error {
  constructor(name: string, version: number, first: string, second: string) {
    super(`workflow '${name}' version ${version} is declared by ${first} and ${second}`);
    this.name = 'DuplicateWorkflowDefinition';
  }
}

export class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonDeterminismError';
  }
}

/** Thrown by a durable operation that cannot finish in this activation; the engine parks the instance. */
export class WorkflowSuspended {
  public readonly name = 'WorkflowSuspended';
}

export type AbortReason = 'lease-lost' | 'cancelled' | 'shutdown' | 'crashed' | 'journal-failed';

/** What a durable operation throws once the activation's signal has aborted. */
export class WorkflowAborted extends Error {
  constructor(public readonly reason: AbortReason) {
    super(`workflow activation aborted: ${reason}`);
    this.name = 'WorkflowAborted';
  }
}

/** A fenced write matched no row: another replica holds a newer claim. */
export class LeaseLostError extends Error {
  constructor(instanceId: string) {
    super(`workflow instance '${instanceId}' is owned by another replica`);
    this.name = 'LeaseLostError';
  }
}

export class WorkflowFailure extends NonRetryableError {
  constructor(public readonly reason: string, public readonly details?: unknown) {
    super(reason);
    this.name = 'WorkflowFailure';
  }
}

/** A step failed for good. A replay throws it again from the journal, without the original error object. */
export class WorkflowStepFailed extends Error {
  constructor(public readonly step: string, public readonly error: SerializedError, public readonly original?: unknown) {
    super(`step '${step}' failed: ${error.message}`);
    this.name = 'WorkflowStepFailed';
  }

  public get errorName(): string {
    return this.error.name;
  }
}

export class WorkflowStepResultTooLarge extends NonRetryableError {
  constructor(step: string, bytes: number | null, limit: number) {
    super(bytes === null ? `step '${step}' returned a value that is not JSON-serializable` : `step '${step}' returned ${bytes} bytes of JSON, over workflow.maxStepResultBytes (${limit})`);
    this.name = 'WorkflowStepResultTooLarge';
  }
}

export class WorkflowNestingError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowNestingError';
  }
}

/** An error with `crash: true` stands for a dead replica: the activation stops writing at once. */
export function isCrash(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { crash?: unknown }).crash === true;
}

export function serializeError(err: unknown, step?: string): SerializedError {
  if (err instanceof WorkflowStepFailed) return { ...err.error, step: step ?? err.step };
  const out: SerializedError = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: safeStringify(err) ?? Object.prototype.toString.call(err) };
  if (err instanceof Error && err.stack) out.stack = err.stack;
  if (step !== undefined) out.step = step;
  if (err instanceof WorkflowFailure && err.details !== undefined) {
    const json = safeStringify(err.details);
    if (json !== undefined) out.details = JSON.parse(json) as unknown;
  }
  return out;
}
