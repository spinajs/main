import { CommandOptions } from 'commander';
import { IArgument, IOption } from './interfaces';

export const META_COMMAND = 'cli:command';
export const META_ARGUMENT = 'cli:argument';
export const META_OPTION = 'cli:options';

export function Command(nameAndArgs: string, description: string, opts?: CommandOptions) {
  return function (target: object) {
    const arg = {
      nameAndArgs,
      description,
      opts,
    };

    Reflect.defineMetadata(META_COMMAND, target, arg);
  };
}

export function Option(flags: string, description?: string, defaultValue?: string | boolean | string[]) {
  return function (target: object) {
    const arg = {
      flags,
      description,
      defaultValue,
    };
    let args: IOption[] = [];

    if (Reflect.hasMetadata(META_OPTION, target)) {
      args = Reflect.getMetadata(META_OPTION, target) as IOption[];
    }
    args.push(arg);

    Reflect.defineMetadata(META_OPTION, target, args);
  };
}

export function Argument(name: string, description?: string, defaultValue?: unknown) {
  return function (target: object) {
    const arg = {
      name,
      description,
      defaultValue,
    };
    let args: IArgument[] = [];

    if (Reflect.hasMetadata(META_ARGUMENT, target)) {
      args = Reflect.getMetadata(META_ARGUMENT, target) as IArgument[];
    }
    args.push(arg);

    Reflect.defineMetadata(META_ARGUMENT, target, args);
  };
}
