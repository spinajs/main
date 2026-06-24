import { Command, Option } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('env-cmd', 'env command')
@Option({ flags: '-h, --host <host>', required: false, env: 'TEST_CLI_HOST' })
export class TestCommandEnv extends CliCommand {
  public execute(_options: { host?: string }): Promise<void> {
    return Promise.resolve();
  }
}
