import { CliCommand, IArgument, ICommand, IOption } from './interfaces.js';
import { META_ARGUMENT, META_COMMAND, META_OPTION } from './decorators.js';
import { AsyncService, Class, DI } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { program } from 'commander';

export * from './interfaces.js';
export * from './decorators.js';

DI.register(() => {
  return process.argv;
}).as('__cli_argv_provider__');

export class Cli extends AsyncService {
  @Logger('CLI')
  protected Log: Log;

  public Commands: Array<Class<CliCommand>> = [];

  public async resolve(): Promise<void> {
    this.Commands = DI.getRegisteredTypes<CliCommand>('__cli_command__');

    for (const cClass of this.Commands) {
      this.Log.trace(`Found command ${cClass.name}`);

      const command = await DI.resolve(cClass);

      const cMeta = Reflect.getMetadata(META_COMMAND, cClass as object) as ICommand;
      const oMeta = Reflect.getMetadata(META_OPTION, cClass as object) as IOption[];
      const aMeta = Reflect.getMetadata(META_ARGUMENT, cClass as object) as IArgument[];

      const c = program.command(cMeta.nameAndArgs, cMeta.description, cMeta.opts);

      oMeta.forEach((o) => {
        if (o.required) {
          c.requiredOption(o.flags, o.description, o.parser, o.defaultValue);
        } else {
          c.option(o.flags, o.description, o.parser, o.defaultValue);
        }
      });

      aMeta.forEach((a) => {
        c.argument(a.name, a.description, a.parser, a.defaultValue);
      });

      command.onCreation(c);

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await command.execute(...args);
      });
    }

    const argv = DI.resolve<string[]>('__cli_argv_provider__');

    program.parse(argv);
  }
}
