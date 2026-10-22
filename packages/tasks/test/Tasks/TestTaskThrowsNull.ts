import { Task } from '../../src/decorators.js';

export class TestTaskThrowsNull {
  @Task('TestTaskThrowsNull', 'Task that throws a non-Error value')
  public execute(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the task under test must reject with a non-Error value
    return Promise.reject(null);
  }
}
