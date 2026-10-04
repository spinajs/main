#!/usr/bin/env node
import { main } from './cli.js';

// exit() and not exitCode: a config file may leave a timer or a socket open.
void main(process.argv.slice(2)).then((code) => process.exit(code));
