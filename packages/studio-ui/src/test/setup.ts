import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach } from 'vitest';
import { stubBrowserApis } from './browser-stubs';
import { FakeEventSource } from './fake-events';

// Setup also runs for the node-environment tests of scripts/, which have no DOM to stub and no storage to clear.
const hasDom = typeof window !== 'undefined';

MotionGlobalConfig.skipAnimations = true;
if (hasDom) stubBrowserApis();

beforeEach(() => FakeEventSource.install());
afterEach(() => {
  cleanup();
  if (hasDom) localStorage.clear();
});
