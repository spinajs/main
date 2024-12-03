import { Task } from '../../src/decorators.js';

export class TestTask {
  @Task('TestTask', 'Sample test task', {
    taskStacking: false,
  })
  public execute(_n:  number): Promise<any> {
    return Promise.resolve();
  }
}
