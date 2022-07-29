#!/usr/bin/env node
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { Cli } from './index';

async function cli() {
  const log = DI.resolve(Log, ['CLI']);

  try {
    await DI.resolve(Cli);
    process.exit(1);
  } catch (err) {
    log.error(err.message as string);
    process.exit(-1);
  }
}

void cli();
