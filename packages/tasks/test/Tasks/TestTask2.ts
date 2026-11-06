import { Task } from '../../src/decorators.js';

export const testTask2Gate: { release: () => void; promise: Promise<void> } = { release: () => {}, promise: Promise.resolve() };

export function closeTestTask2Gate(): void {
  testTask2Gate.promise = new Promise<void>((resolve) => (testTask2Gate.release = resolve));
}

export class TestTask2 {
  @Task('TestTask2', 'Task that waits for its gate', {
    taskStacking: false,
  })
  public execute(n: number): Promise<number> {
    return testTask2Gate.promise.then(() => n);
  }
}

export class TestTaskStacking {
  @Task('TestTaskStacking', 'Stacking task that waits for the same gate', { taskStacking: true })
  public execute(n: number): Promise<number> {
    return testTask2Gate.promise.then(() => n);
  }
}
