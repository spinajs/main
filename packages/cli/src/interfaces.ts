import { AsyncModule } from '@spinajs/di';
import { CommandOptions } from 'commander';

export interface ICommand {
  nameAndArgs: string;
  opts?: CommandOptions;
  description: string;
}

export interface IOption {
  flags: string;
  description?: string;
  defaultValue?: string | boolean | string[];
  required?: boolean;
}

export interface IArgument {
  name: string;
  description?: string;
  defaultValue?: unknown;
  required?: boolean;
}

export abstract class CliCommand extends AsyncModule {
  public abstract execute(...args: any[]): Promise<void>;
}
