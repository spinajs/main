#!/usr/bin/env node
import { Bootstrapper, DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { Cli } from './index.js';
import { Configuration } from '@spinajs/configuration-common';
import './args.js';

async function cli() {
  DI.setESMModuleSupport();
  await DI.resolve(Configuration);

  const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }
  
  const log = DI.resolve(Log, ['CLI']);

  log.success('Welcome to spinajs cli...');

  try {
    await DI.resolve(Cli);

    // force process exit
    // TODO: could couse bug becouse process will be forced to exit
    // immediatelly
    process.exit(1);
  } catch (err) {
    log.error(err.message as string);
    process.exit(-1);
  }
}

void cli();
