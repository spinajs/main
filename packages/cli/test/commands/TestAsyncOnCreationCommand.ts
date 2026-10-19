import { Command } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';
import { CommanderCommand, CommanderOption } from './../../src/commander.js';

@Command('async-creation-cmd', 'command adding an option in an async onCreation')
export class TestAsyncOnCreationCommand extends CliCommand {
  public async onCreation(command: CommanderCommand): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    command.addOption(new CommanderOption('--late <value>'));
  }

  public execute(_options: { late?: string }): Promise<void> {
    return Promise.resolve();
  }
}
