import { Schedule } from '../../../src/decorators.js';
import { ScheduledTask } from '../../../src/ScheduledTask.js';

@Schedule('manifest-alpha', { every: '5m' })
export class AlphaSchedule extends ScheduledTask {
  public execute() {
    return 'alpha';
  }
}
