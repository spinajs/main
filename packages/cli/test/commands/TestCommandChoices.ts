import { Command, Argument, Option } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

// object-form decorators exercising choices on both an argument and an option
@Command({ nameAndArgs: 'choice-cmd', description: 'choices command' })
@Argument({ name: 'color', required: true, choices: ['red', 'green'] })
@Option({ flags: '-s, --size <size>', required: false, choices: ['s', 'm', 'l'] })
export class TestCommandChoices extends CliCommand {
  public execute(_color: string, _options: unknown): Promise<void> {
    return Promise.resolve();
  }
}
