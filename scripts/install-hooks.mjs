#!/usr/bin/env node
/**
 * Points git at the versioned hooks in .githooks/. Runs on `npm install` (prepare).
 *
 * Usage:  node scripts/install-hooks.mjs
 */
import { spawnSync } from 'node:child_process';

// Outside a git checkout (published tarball, Docker build) there is nothing to install,
// so a failing git call must not fail `npm install`.
spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
