import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

/** A test application whose only configuration is the `tenancy` section; no Bootstrapper of another package runs. */
export function tenancyApp(tenancy: Record<string, unknown> = {}): Promise<TestApp> {
  return createTestApp({ bootstrap: false, config: { tenancy } });
}
