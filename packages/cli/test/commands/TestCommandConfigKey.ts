import { Command, Option } from './../../src/decorators.js';
import { CliCommand } from './../../src/interfaces.js';

@Command('config-cmd', 'config command')
@Option({ flags: '-p, --port <port>', required: false, configKey: 'test.cli.port' })
export class TestCommandConfigKey extends CliCommand {
  public execute(_options: { port?: number }): Promise<void> {
    return Promise.resolve();
  }
}
