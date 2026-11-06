import { Task } from '../../src/decorators.js';

export class TestTaskCrash {
  @Task('TestTaskCrash', 'Task whose process dies')
  public execute(): Promise<void> {
    return Promise.reject(Object.assign(new Error('process died'), { crash: true }));
  }
}
