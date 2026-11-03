#!/usr/bin/env node
import { enableCompileCache } from './compile-cache.js';

// The cache covers only modules compiled after it is on, so the bin loads the CLI itself through a dynamic import.
enableCompileCache();
await import('./run-cli.js');
