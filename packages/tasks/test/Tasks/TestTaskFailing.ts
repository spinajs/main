import { Task } from '../../src/decorators.js';

export class TestTaskFailing {
  @Task('TestTaskFailing', 'Task that throws', { taskStacking: false })
  public execute(): Promise<void> {
    return Promise.reject(new Error('boom'));
  }
}
