import { Schedule } from '../../../src/decorators.js';
import { ScheduledTask } from '../../../src/ScheduledTask.js';

@Schedule('manifest-beta', { every: '10m' })
export class BetaSchedule extends ScheduledTask {
  public execute() {
    return 'beta';
  }
}
