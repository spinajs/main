import { Log, Logger } from '@spinajs/log';
import { Command, Argument, Option } from '../../src/decorators.js';
import { CliCommand } from '../../src/interfaces.js';

interface TestOptions {
  timeout: number;
}

@Command('test-command2', 'test command')
@Argument('login', 'login')
@Argument('password', 'password')
@Option('-t, --timeout <timeout>', true, 'timeout time', 0, (a: string) => parseInt(a))
export class TestCommand2 extends CliCommand {
  @Logger('command')
  protected Log: Log;

  public execute(login: string, password: string, options: TestOptions): Promise<void> {
    this.Log.trace(`${login} ${password} ${options.timeout}`);
    return Promise.resolve();
  }
}
