import { Task } from '../../src/decorators.js';

export class TestTask2 {
  @Task('TestTask2', 'Sample test task', {
    taskStacking: false,
  })
  public execute(_n: number): Promise<any> {
    return new Promise<void>((res) => {
      setTimeout(() => {
        res();
      }, 1000);
    });
  }
}
