import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('kept', { every: '1h' })
export class KeptTask extends ScheduledTask {}
