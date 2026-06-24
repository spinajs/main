import { Command, Argument } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('variadic-cmd', 'variadic command')
@Argument({ name: 'files', required: true, variadic: true })
export class TestCommandVariadic extends CliCommand {
  public execute(_files: string[]): Promise<void> {
    return Promise.resolve();
  }
}
