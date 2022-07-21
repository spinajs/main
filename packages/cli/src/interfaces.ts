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
}

export interface IArgument {
  name: string;
  description?: string;
  defaultValue?: unknown;
}
