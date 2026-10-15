import { Conflict, HandleException } from '@spinajs/http';
import { InvalidRunState, SchedulePaused } from '@spinajs/scheduler';

/**
 * @spinajs/http maps the other scheduler errors through their base classes ( ResourceNotFound,
 * ResourceDuplicated, InvalidArgument ) but has no mapping for InvalidOperation, which would
 * answer 500 where the contract's httpStatusForError says 409.
 */
@HandleException([InvalidRunState, SchedulePaused])
export class SchedulerConflict extends Conflict {}
