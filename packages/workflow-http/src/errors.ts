import { BadRequestResponse, Conflict, HandleException, NotFound } from '@spinajs/http';
import { WorkflowIdConflict, WorkflowNotFound, WorkflowNotRegistered, WorkflowNotRetryable, WorkflowStartConflict } from '@spinajs/workflow';

@HandleException([WorkflowNotFound])
export class WorkflowInstanceMissing extends NotFound {}

@HandleException([WorkflowNotRegistered])
export class WorkflowUnknown extends BadRequestResponse {}

@HandleException([WorkflowIdConflict, WorkflowStartConflict, WorkflowNotRetryable])
export class WorkflowConflict extends Conflict {}
