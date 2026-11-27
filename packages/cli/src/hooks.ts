import type { Command } from 'commander';
import type { IOption } from './interfaces.js';

/** The command whose action is about to run. */
export interface CliHookCommand {
  /** The command's name, e.g. `migrate-up`. */
  readonly name: string;
  /** Its parsed options merged with those of every command above it, the program's global options included. */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Wraps the action of every command and may add options every command accepts; `@spinajs/tenancy/cli` adds
 * `--tenant` and `--all-tenants` and runs the action in that scope. None is registered by default.
 */
export abstract class CliCommandHook {
  /** A lower order is further out; among hooks of one order, the first registered. */
  public readonly order: number = 0;

  /** Added to the program, so they are accepted before and after any command name. */
  public options(): readonly IOption[] {
    return [];
  }

  public abstract aroundExecute<T>(command: CliHookCommand, next: () => Promise<T>): Promise<T>;
}

export function runCliHooks<T>(hooks: readonly CliCommandHook[], command: CliHookCommand, work: () => Promise<T>): Promise<T> {
  return hooks.reduceRight<() => Promise<T>>((next, hook) => () => hook.aroundExecute(command, next), work)();
}

/** A command's options merged with those of every command above it, as commander's `optsWithGlobals()` merges them. */
export function optionsOf(command: Command): Readonly<Record<string, unknown>> {
  let merged: Record<string, unknown> = {};
  for (let c: Command | null = command; c; c = c.parent) merged = { ...merged, ...c.opts() };
  return merged;
}
