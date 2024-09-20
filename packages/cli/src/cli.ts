#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { Cli } from './index.js';
import { Configuration } from '@spinajs/configuration-common';
import './args.js';

async function cli() {
  DI.setESMModuleSupport();
  const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));

  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);

  const log = DI.resolve(Log, ['CLI']);

  log.success('Welcome to spinajs cli...');

  try {
    await DI.resolve(Cli);
    process.exit(1);
  } catch (err) {
    log.error(err.message as string);
    process.exit(-1);
  }
}

void cli();
