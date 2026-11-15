import { describeQueueTransportConformance } from '../src/testing/index.js';
import { memoryHarness } from './support/memory-harness.js';

describeQueueTransportConformance('MemoryQueueClient', memoryHarness);
