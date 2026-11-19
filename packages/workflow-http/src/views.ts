import type { SerializedError, WorkflowEventView, WorkflowInstanceDetail, WorkflowInstanceView, WorkflowStepView } from '@spinajs/workflow';

export type ErrorSummary = Pick<SerializedError, 'name' | 'message' | 'step'>;

/** What `workflow:read` shows of an instance: no input, no result, and of an error only what `ErrorSummary` names. */
export type WorkflowInstanceSummary = Omit<WorkflowInstanceView, 'input' | 'result' | 'error'> & { error: ErrorSummary | null };

export type WorkflowStepSummary = Omit<WorkflowStepView, 'error'> & { error: ErrorSummary | null };

export type WorkflowInstanceOverview = WorkflowInstanceSummary & { steps: WorkflowStepSummary[]; pendingEvents: WorkflowEventView[] };

// The fields are named, not "everything but stack": a field added to SerializedError later stays hidden until someone decides.
function errorSummary(error: SerializedError | null): ErrorSummary | null {
  if (!error) return null;
  return { name: error.name, message: error.message, ...(error.step !== undefined ? { step: error.step } : {}) };
}

export function summaryOf(view: WorkflowInstanceView): WorkflowInstanceSummary {
  const { input: _input, result: _result, error, ...rest } = view;
  return { ...rest, error: errorSummary(error) };
}

export function overviewOf(detail: WorkflowInstanceDetail): WorkflowInstanceOverview {
  const { steps, pendingEvents, ...view } = detail;
  return { ...summaryOf(view), steps: steps.map((s) => ({ ...s, error: errorSummary(s.error) })), pendingEvents };
}
