import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Schedule('basic-task', { every: '1h' })
export class BasicTask extends ScheduledTask {
  public execute(): string {
    return 'basic';
  }
}
