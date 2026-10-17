# CLI command and helpers

The package ships the `template-render` command for testing templates from a terminal, and exports the helpers that `render-pdf` (`@spinajs/templates-pdf`) and `render-image` (`@spinajs/templates-image`) are built on. Use the helpers to write your own render commands.

## How it works

`spinajs template-render <template> [-f <file>] [-m <model>] [-l <lang>]`:

1. `@spinajs/cli` finds `RenderTemplateCommand` in `lib/<mjs|cjs>/cli/`, a directory this package adds to `system.dirs.cli`.
2. `execute()` resolves `Templates`.
3. With `-m` and an existing file, the file is parsed as JSON into the model; otherwise the model is `{}`.
4. With `-f`, the parent directory is created and `Templates.renderToFile(template, model, file, lang)` writes the output. A `success` entry is logged.
5. Without `-f`, `Templates.render(template, model, lang)` runs and the output is printed raw with `console.log`.
6. Any error is logged on the `templates` logger as `Cannot render template ...`.

| Argument / option | Required | Meaning |
| --- | --- | --- |
| `<template>` | yes | Template path or `fs://` URI; its extension selects the renderer |
| `-f, --file [file]` | no | Write the output to this file instead of stdout |
| `-m, --model [model]` | no | Path to a JSON file used as the model |
| `-l, --lang [lang]` | no | Render language; the default language when omitted |

```sh
spinajs template-render ./views/mail/welcome.handlebars -m ./fixtures/welcome.json -l pl
spinajs template-render ./views/invoice.pdf -m ./fixtures/invoice.json -f ./out/invoice.pdf
```

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | this package appends `node_modules/@spinajs/templates/lib/<mjs\|cjs>/cli` under `WORKSPACE_ROOT_PATH` (or the working directory) and one directory up | absolute paths | Where `@spinajs/cli` looks for commands |

## Helpers

| Export | Signature | Meaning |
| --- | --- | --- |
| `loadJsonModel(modelPath?)` | `Record<string, unknown>` | Parses the JSON file; `{}` when no path is given or the file does not exist |
| `resolveInputHtml(input, options)` | `Promise<string>` | `options.template` `true`: renders `input` with `Templates.render(input, loadJsonModel(options.model), options.lang)`. Otherwise reads `input` as raw HTML; a missing file throws `Input HTML file ... does not exist` |
| `IResolveHtmlOptions` | `{ template?, model?, lang? }` | Options of `resolveInputHtml()`, shaped like CLI options |
| `cliProgressReporter(write?, isTty?)` | `RenderProgressCallback` | Live progress line; see [Render progress](04-render-progress.md#api) |
| `formatProgressLine(p)` | `string` | One progress snapshot as a line |
| `ensureParentDir(filePath)` | `void` | Creates the parent directory of an output file |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RenderTemplateCommand` | No DI token: discovered as a file in `system.dirs.cli`, built by `@spinajs/cli` when invoked | `template-render` | `render-pdf`, `render-image` from the puppeteer engine packages | Not exported from the package entry, so it cannot be subclassed by import. Ship your own `CliCommand` with the helpers above |

### Your own render command

`template-render` logs failures and still exits with code `0`, which CI cannot detect. The sample command renders a report with progress and rethrows, so the process fails.

```ts sample
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { cliProgressReporter, ensureParentDir, loadJsonModel, Templates } from '@spinajs/templates';

interface IRenderReportOptions {
  output: string;
  model?: string;
  lang?: string;
}

@Command('report:render', 'Render a report template to a file, failing the process on error')
@Argument('template', true, 'template path or fs:// uri')
@Option('-o, --output <file>', true, 'output file')
@Option('-m, --model [model]', false, 'JSON model file')
@Option('-l, --lang [lang]', false, 'render language')
export class RenderReportCommand extends CliCommand {
  @Logger('reports')
  protected Log: Log;

  public async execute(template: string, options: IRenderReportOptions): Promise<void> {
    const templates = await DI.resolve(Templates);

    ensureParentDir(options.output);
    await templates.renderToFile(template, loadJsonModel(options.model), options.output, options.lang, {
      onProgress: cliProgressReporter(),
    });

    this.Log.success({ output: options.output }, 'Report written to ${output}');
  }
}
```

Put the file in a directory listed in `system.dirs.cli`; see [Command discovery](../cli/05-command-discovery.md#ship-commands-from-your-own-package).

## Important behaviour

- `template-render` swallows errors: it logs them and returns, so the exit code is `0` even when rendering fails.
- A `-m` path that does not exist is ignored silently; the template renders with `{}`.
- Without `-f`, the output goes to stdout through `console.log`, after the CLI's own log lines.
- File-only renderers (pdf, image, xlsx) need `-f`; without it their `render()` throws `NotSupported`, which is logged.
- `lib/<mjs|cjs>/cli/` also holds `renderHelpers.js`. `@spinajs/cli` lists it as a command file, finds no `@Command` metadata and logs a warning `... is not marked as command`.

## Best practices

- Keep a JSON fixture per template (`fixtures/<template>.json`) and render it with `-m` while editing the template.
- Use `-l` to check every language of a translated template before release.

## Patterns and antipatterns

```ts
// Don't: in CI, template-render cannot fail the build
// "check:templates": "spinajs template-render views/mail/welcome.handlebars -m fixtures/welcome.json"

// Do: a command that rethrows, like report:render above
// "check:templates": "spinajs report:render views/mail/welcome.handlebars -o out/welcome.html -m fixtures/welcome.json"
```

## Examples

### Strip style blocks from raw HTML or a rendered template

```ts sample
import { writeFile } from 'fs/promises';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { ensureParentDir, IResolveHtmlOptions, resolveInputHtml } from '@spinajs/templates';

interface IStripStylesOptions extends IResolveHtmlOptions {
  output: string;
}

@Command('mail:strip-styles', 'Render a mail template (or read raw HTML) and strip <style> blocks for clients that drop them')
@Argument('input', true, 'html file, or a template when --template is set')
@Option('-o, --output <file>', true, 'output html file')
@Option('-t, --template', false, 'render input through its template engine')
@Option('-m, --model [model]', false, 'JSON model file, template mode only')
@Option('-l, --lang [lang]', false, 'language, template mode only')
export class StripStylesCommand extends CliCommand {
  public async execute(input: string, options: IStripStylesOptions): Promise<void> {
    const html = await resolveInputHtml(input, options);

    ensureParentDir(options.output);
    await writeFile(options.output, html.replace(/<style[\s\S]*?<\/style>/gi, ''), 'utf-8');
  }
}
```

## Related

- [Command discovery](../cli/05-command-discovery.md): how `system.dirs.cli` is scanned.
- [Commands](../cli/02-commands.md): `@Command`, `@Argument`, `@Option`.
- [Render progress](04-render-progress.md): the progress line.
- [`@spinajs/templates-pdf`](../templates-pdf/README.md): `render-pdf`, built on these helpers.
