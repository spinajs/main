import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('unexported', { every: '1h' })
class UnexportedTask extends ScheduledTask {}
