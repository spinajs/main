import { Task } from '../../src/decorators.js';

export class TestTaskNoOptions {
  @Task('TestTaskNoOptions', 'Task declared without options')
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
