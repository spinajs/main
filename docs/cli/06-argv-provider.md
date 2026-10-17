# Argv provider

`Cli` does not read `process.argv` itself. It resolves the string token `'__cli_argv_provider__'` from DI and parses whatever array that returns. Replace the provider to drive commands from tests, from your own entry point, or from a source other than the process arguments.

## How it works

1. **Registration.** The bin's `src/args.ts` runs `DI.register(factory).as('__cli_argv_provider__')` when `cli.js` imports it. It is not part of the package entry (`@spinajs/cli`), so a program that imports only `@spinajs/cli` has no provider.
2. **Resolution.** After building the command tree, `Cli.resolve()` calls `DI.resolve<string[]>('__cli_argv_provider__')`. A factory registration is called on every resolve, and the last registration under the token wins.
3. **Default filter.** The default factory copies `process.argv` and removes `--app`, `--env`, `--apppath` together with their value (`--env production`), and the single-token forms (`--env=production`).
4. **Empty check.** When the array has no entries after the first two (`node` and the script), `Cli` prints the program help and returns.
5. **Parse.** Otherwise `program.parseAsync(argv)` parses it with commander's default `{ from: 'node' }`: the first two entries are skipped.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Argv provider | String token `'__cli_argv_provider__'`; a factory `() => string[]`, called on each resolve; last registration wins | Factory in `src/args.ts`: `process.argv` minus `--app`, `--env`, `--apppath` and their values | none shipped | `DI.register(() => [...]).as('__cli_argv_provider__')` before `DI.resolve(Cli)` |

The returned array must keep the Node layout: two leading entries (any strings), then the command and its arguments.

### Argv provider: custom implementation

Register a factory when you run `Cli` yourself. Two common reasons:

- **Tests.** Run one command with fixed arguments, as `packages/cli/test/cli.test.ts` does.
- **Custom entry points.** Your own bin needs the same framework-option filter as `spinajs`, or extra options of its own to strip.

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Cli } from '@spinajs/cli';
import '@spinajs/log';

/** Options this tool reads itself and must hide from commander. */
const TOOL_OPTIONS = ['--app', '--env', '--apppath', '--profile'];

function stripToolOptions(argv: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (TOOL_OPTIONS.some((o) => arg.startsWith(`${o}=`))) continue;
    if (TOOL_OPTIONS.includes(arg)) {
      i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export async function main(): Promise<void> {
  DI.setESMModuleSupport();
  DI.register(() => stripToolOptions(process.argv)).as('__cli_argv_provider__');

  await DI.resolve(Configuration);
  await DI.resolve(Cli);
}
```

## Important behaviour

- Without a registered provider, `DI.resolve('__cli_argv_provider__')` returns `null` and `Cli.resolve()` fails with a `TypeError` on `argv.slice`. Register a provider in every entry point other than the `spinajs` bin.
- The provider runs after the tree is built and after every command file is imported. A command file can therefore register a provider at import time and override the default; avoid that, it changes argv for every command.
- The default filter removes the token after `--app`, `--env` or `--apppath` even when it looks like another option: `spinajs --env --help` drops `--help`.
- `Cli` is a singleton. Resolving it a second time in the same container returns the cached instance without parsing again; tests call `DI.clearCache()` between runs.

## Best practices

- In tests, register the provider right before `DI.resolve(Cli)` and clear the DI cache between tests, so each test gets a fresh `Cli` and its own argv.
- Keep the two leading entries (`'node', 'script.js'`) in hand-written arrays; without them commander skips your command name.

## Patterns and antipatterns

```ts
// Don't: commander skips the first two entries, so 'cache:warm' and '--all' are lost and the help is printed
DI.register(() => ['cache:warm', '--all']).as('__cli_argv_provider__');

// Do
DI.register(() => ['node', 'spinajs', 'cache:warm', '--all']).as('__cli_argv_provider__');
```

## Examples

### Test a command end to end

```ts sample
import { strict as assert } from 'assert';
import { join } from 'path';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Cli, CliCommand, Command, Option } from '@spinajs/cli';
import '@spinajs/log';

// Lives in test/commands/WarmCache.ts, the scanned directory; inlined here to keep the sample complete.
@Command('cache:warm', 'Fills the cache')
@Option('-a, --all', false, 'warm every region')
export class WarmCacheCommand extends CliCommand {
  public static lastRun: { all?: boolean } | undefined;

  public async execute(options: { all?: boolean }): Promise<void> {
    WarmCacheCommand.lastRun = options;
  }
}

/** Test configuration: silent logger, scans test/commands. */
class TestConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: { dirs: { cli: [join(process.cwd(), 'test', 'commands')] } },
    };
  }
}

export async function warmCacheRunsWithAll(): Promise<void> {
  DI.clearCache();
  DI.setESMModuleSupport();
  DI.register(TestConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  DI.register(() => ['node', 'spinajs', 'cache:warm', '--all']).as('__cli_argv_provider__');
  await DI.resolve(Cli);

  assert.deepEqual(WarmCacheCommand.lastRun, { all: true });
}
```

## Related

- [Running the CLI](01-running-the-cli.md#framework-options): the options the default provider removes.
- [`Cli` service](07-cli-service.md): where the provider is resolved, and running `Cli` from your own entry point.
