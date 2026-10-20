import { Task } from '../../src/decorators.js';

export class TestTaskValue {
  @Task('TestTaskValue', 'Task that returns a value')
  public execute(): Promise<{ sent: number }> {
    return Promise.resolve({ sent: 3 });
  }
}
