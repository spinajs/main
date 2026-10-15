import { Task } from '../../src/decorators.js';

export class TestTaskHeartbeat {
  @Task('TestTaskHeartbeat', 'Long task with a short lock ttl', { taskStacking: false, lockTtl: 300 })
  public execute(): Promise<void> {
    return new Promise<void>((res) => setTimeout(res, 1000));
  }
}
