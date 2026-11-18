import { HandleException, NotFound } from '@spinajs/http';
import { WorkflowNotFound } from '@spinajs/workflow';

@HandleException([WorkflowNotFound])
export class WorkflowInstanceMissing extends NotFound {}
