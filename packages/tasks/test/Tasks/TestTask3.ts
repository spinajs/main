import { Task } from '../../src/decorators.js';

export class TestTask3 {
  @Task('TestTask3', 'Sample failing task', {
    taskStacking: false,
  })
  public execute(): Promise<any> {
    return Promise.reject(new Error('task failed'));
  }
}
