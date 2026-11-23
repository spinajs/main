import { createTestApp } from '@spinajs/testing';
import type { TestApp, TestAppOptions } from '@spinajs/testing';

/** A test application whose only configuration is the `tenancy` section; no Bootstrapper of another package runs. */
export function tenancyApp(tenancy: Record<string, unknown> = {}, register?: TestAppOptions['register']): Promise<TestApp> {
  return createTestApp({ bootstrap: false, config: { tenancy }, register });
}
