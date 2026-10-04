#!/usr/bin/env node
import { main } from './cli.js';

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
