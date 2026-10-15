import { Task } from '../../src/decorators.js';

export class TestTaskThrowsNull {
  @Task('TestTaskThrowsNull', 'Task that throws a non-Error value')
  public execute(): Promise<void> {
    // eslint-disable-next-line prefer-promise-reject-errors
    return Promise.reject(null);
  }
}
