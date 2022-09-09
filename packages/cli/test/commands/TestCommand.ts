import { Log, Logger } from '@spinajs/log';
import { Command, Argument, Option } from './../../src/decorators';
import { CliCommand } from './../../src/interfaces';

@Command('test-command', 'test command')
@Argument('login', 'login')
@Argument('password', 'password')
@Option('-t, --timeout <timeout>', true, 'timeout time')
export class TestCommand extends CliCommand {
  @Logger('command')
  protected Log: Log;

  public execute(login: string, password: string, timeout: number): Promise<void> {
    this.Log.trace(`${login} ${password} ${timeout}`);
    return Promise.resolve();
  }
}
