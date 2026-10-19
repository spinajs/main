import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

// The command is not the first export, so discovery must look past the others.
export const EXTRA_EXPORTS_VERSION = '1.0';

export class ExtraExportsHelper {}

@Command('extra-exports', 'command file with other exports')
export class TestCommandExtraExports extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
