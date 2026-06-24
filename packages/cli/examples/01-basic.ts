/**
 * Basic command — positional decorators.
 *
 * Run:
 *   spinajs greet World
 *   spinajs greet World --loud --repeat 3
 */
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command, Argument, Option } from '@spinajs/cli';

interface GreetOptions {
  loud?: boolean;
  repeat: number;
}

@Command('greet', 'Greets a user')
@Argument('name', true, 'who to greet')
@Option('-l, --loud', false, 'shout the greeting')
@Option('-r, --repeat <times>', false, 'how many times to greet', 1, (v) => parseInt(v, 10))
export class GreetCommand extends CliCommand {
  @Logger('greet')
  protected Log: Log;

  // arguments arrive in declaration order, followed by the options object
  public async execute(name: string, options: GreetOptions): Promise<void> {
    const message = options.loud ? `HELLO, ${name.toUpperCase()}!` : `Hello, ${name}!`;

    for (let i = 0; i < options.repeat; i++) {
      this.Log.info(message);
    }
  }
}
