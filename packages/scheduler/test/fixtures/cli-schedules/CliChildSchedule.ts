import { Schedule } from '../../../src/decorators.js';
import { ScheduledTask } from '../../../src/ScheduledTask.js';

@Schedule('cli-child', { every: '5m' })
export class CliChildSchedule extends ScheduledTask {
  public execute() {
    return 'child';
  }
}
