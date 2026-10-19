import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('greet <name>', 'command with arguments in nameAndArgs')
export class TestCommandInlineArgs extends CliCommand {
  public execute(_name: string): Promise<void> {
    return Promise.resolve();
  }
}
