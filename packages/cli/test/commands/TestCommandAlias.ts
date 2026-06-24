import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command({ nameAndArgs: 'aliased-cmd', description: 'aliased command', aliases: ['ac', 'alias2'] })
export class TestCommandAlias extends CliCommand {
  public execute(): Promise<void> {
    return Promise.resolve();
  }
}
