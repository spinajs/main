import { IArgument, ICommand, IOption } from './interfaces';
import { META_COMMAND, META_OPTION } from './decorators';
import { AsyncModule } from '@spinajs/di';
import { Logger, ILog } from '@spinajs/log';
import { ResolveFromFiles, ClassInfo } from '@spinajs/reflection';
import { Command } from 'commander';

export abstract class CliCommand extends AsyncModule {
  public abstract execute(...args: any[]): Promise<void>;
}

export class Cli extends AsyncModule {
  @Logger('spinajs-cli')
  protected Log: ILog;

  @ResolveFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.cli')
  public Commands: Promise<Array<ClassInfo<CliCommand>>>;

  protected Program: Command;

  public async resolveAsync(): Promise<void> {
    for (const command of await this.Commands) {
      this.Log.trace(`Found command ${command.name} in file ${command.file}`);

      const cMeta = Reflect.getMetadata(META_COMMAND, command.type as object) as ICommand;
      const oMeta = Reflect.getMetadata(META_OPTION, command.type as object) as IOption[];
      const aMeta = Reflect.getMetadata(META_OPTION, command.type as object) as IArgument[];

      const c = this.Program.command(cMeta.nameAndArgs, cMeta.description, cMeta.opts);

      oMeta.forEach((o) => {
        c.option(o.flags, o.description, o.defaultValue);
      });

      aMeta.forEach((a) => {
        c.argument(a.name, a.description, a.defaultValue);
      });

      c.action(async (...args) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await command.instance.execute(...args);
      });
    }

    if (process.argv.length < 3) {
      this.Program.help();
      return;
    }

    this.Program.parse(process.argv);
  }
}
