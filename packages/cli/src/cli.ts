#!/usr/bin/env node
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { Cli } from './index.js';
import { Configuration } from '@spinajs/configuration-common';

DI.register(() => {
  return process.argv;
}).as('__cli_argv_provider__');

async function cli() {

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
