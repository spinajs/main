import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('dirs-pkg.opt-in', { every: '1h' })
export class OptInTask extends ScheduledTask {}
