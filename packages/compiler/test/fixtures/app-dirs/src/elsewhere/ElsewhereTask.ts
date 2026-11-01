import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('elsewhere', { every: '1h' })
export class ElsewhereTask extends ScheduledTask {}
