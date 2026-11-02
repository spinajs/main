import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';

// On Node 22 every enabled AsyncLocalStorage is visited for each new promise, and nothing disables one. DI builds a new
// one after each DI.clearCache(), so each boot of this suite would slow every later test down.
const storage = new AsyncLocalStorage();
DI.register(() => storage).as(AsyncLocalStorage);
