import type { OrmDriver } from '@spinajs/orm';

/** What `run` returned and how many statements `driver` executed while it ran. */
export async function counted<T>(driver: OrmDriver, run: () => Promise<T>): Promise<{ result: T; statements: number }> {
  const execute = driver.execute.bind(driver);
  let statements = 0;
  driver.execute = (builder) => {
    statements += 1;
    return execute(builder);
  };
  try {
    const result = await run();
    return { result, statements };
  } finally {
    Reflect.deleteProperty(driver, 'execute');
  }
}
