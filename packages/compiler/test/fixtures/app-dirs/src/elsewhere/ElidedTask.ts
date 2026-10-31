import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('elided', { every: '1h' })
export class ElidedTask extends ScheduledTask {}
