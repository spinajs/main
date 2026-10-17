# `render-image` command

`spinajs render-image` turns an HTML file, or a template, into a PNG or JPEG screenshot. Use it in CI to produce images for visual comparison, or to preview a template without writing code.

```sh
spinajs render-image <input> -o <file> [-t] [-m <model.json>] [-l <lang>] [--width <px>] [--height <px>] [--scale <n>] [--type png|jpeg]
```

## How it works

1. `@spinajs/cli` finds `RenderImageCommand` in this package's `cli` directory, listed under `system.dirs.cli` ([Command discovery](../cli/05-command-discovery.md)).
2. `RenderImageCommand.execute(input, options)` sets the type: `jpeg` when `--type jpeg`, otherwise `png`.
3. It resolves `DI.resolve(ImageRenderer, [{ type }])`.
4. `resolveInputHtml(input, options)` from `@spinajs/templates` builds the HTML:
   - with `--template`, `Templates.render(input, model, lang)` compiles `input` with the text engine its extension selects (`.pug`, `.handlebars`), and `--model` is read as JSON (a missing file gives `{}`);
   - without it, the file is read as is; a missing file throws `Input HTML file <input> does not exist`.
5. `ensureParentDir(output)` creates the output directory.
6. `renderer.renderHtmlToFile(html, output, ...)` renders it ([Image renderer](01-image-renderer.md#rendering-raw-html-to-a-file)) with:
   - `assetBasePath`: the input file's directory, so relative URLs in the HTML resolve;
   - `viewport`: from `--width`, `--height`, `--scale`, when any is given;
   - `onProgress`: `cliProgressReporter()`, a live progress line on a TTY, one line per phase otherwise.
7. Success logs `Rendered <input> to image <output>` to the `templates-image` logger. A failure logs `Cannot render <input> to image` and rethrows.
8. `renderer.dispose()` always runs and closes Chromium, so the process can exit.

## Arguments and options

| Argument or option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `<input>` | yes | none | Path to an `.html` file, or to a template with `--template` |
| `-o, --output <file>` | yes | none | Output image path |
| `-t, --template` | no | off | Compile `input` through `Templates` instead of reading raw HTML |
| `-m, --model [model]` | no | `{}` | JSON file with the template model (template mode) |
| `-l, --lang [lang]` | no | none | Language passed to the template engine (template mode) |
| `--width [width]` | no | `800` when another viewport option is set | Viewport width in px |
| `--height [height]` | no | `600` when another viewport option is set | Viewport height in px |
| `--scale [scale]` | no | `1` when another viewport option is set | Device scale factor |
| `--type [type]` | no | `png` | `png` or `jpeg` |

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `system.dirs.cli` | `string[]` | includes `node_modules/@spinajs/templates-image/lib/<mjs\|cjs>/cli` | Absolute paths | Where `@spinajs/cli` finds this command |
| `templates.image.*` | object | see [Configuration](02-configuration.md) | | Browser, port and timeout settings of the renderer the command uses |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `RenderImageCommand` | A `CliCommand` file found through `system.dirs.cli`; built by `Cli` per run. **Not exported** from `@spinajs/templates-image` | `RenderImageCommand` (`render-image`) | `render-pdf` in `@spinajs/templates-pdf` | It cannot be subclassed from the package entry. Write your own command next to it (example below) |
| Renderer the command uses | `ImageRenderer` class token, resolved with `[{ type }]` | `ImageRenderer` | none | `DI.register(MySubclass).as(ImageRenderer)` in your own CLI entry point, before `DI.resolve(Cli)` ([Run the CLI from your own entry point](../cli/07-cli-service.md#run-the-cli-from-your-own-entry-point)) |
| HTML source and progress | `resolveInputHtml`, `cliProgressReporter`, `ensureParentDir` from `@spinajs/templates` | as shipped | none | Call them from your own command |

### Custom command: a social-card renderer for CI

The shipped command takes only `type` and the viewport. Write a command in your app's `cli` directory when you need other screenshot options, such as WebP output or a clip.

```ts sample
import * as path from 'path';
import { DI } from '@spinajs/di';
import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { cliProgressReporter, ensureParentDir, resolveInputHtml } from '@spinajs/templates';
import { ImageRenderer } from '@spinajs/templates-image';

interface RenderCardOptions {
  output: string;
  model?: string;
  lang?: string;
  quality?: string;
}

@Command('render-card', 'Render a 1200x630 social card template to WebP')
@Argument('input', true, 'template file (.pug or .handlebars)')
@Option('-o, --output <file>', true, 'output .webp file')
@Option('-m, --model [model]', false, 'JSON model file')
@Option('-l, --lang [lang]', false, 'template language')
@Option('-q, --quality [quality]', false, 'WebP quality 0-100, default 85')
export class RenderCardCommand extends CliCommand {
  public async execute(input: string, options: RenderCardOptions): Promise<void> {
    const quality = options.quality ? parseInt(options.quality, 10) : 85;
    const renderer = await DI.resolve(ImageRenderer, [{ type: 'webp', quality }]);

    try {
      const html = await resolveInputHtml(input, { template: true, model: options.model, lang: options.lang });
      ensureParentDir(options.output);

      await renderer.renderHtmlToFile(html, options.output, {
        assetBasePath: path.dirname(path.resolve(input)),
        viewport: { width: 1200, height: 630 },
        onProgress: cliProgressReporter(),
      });
    } finally {
      await renderer.dispose();
    }
  }
}
```

Add your `cli` directory to `system.dirs.cli` in your config so `Cli` finds it ([Command discovery](../cli/05-command-discovery.md)).

## Important behaviour

- **`--type` accepts only `jpeg`.** Any other value, including `jpg` and `webp`, produces PNG without a warning.
- **The type does not follow `--output`.** `--type jpeg -o shot.png` writes JPEG bytes to `shot.png`. Keep the two in line.
- **The viewport is all or nothing.** Give any of `--width`, `--height`, `--scale` and the missing ones default to `800`, `600` and `1`. Give none and Puppeteer's default viewport is used.
- **Template mode needs a text template.** `--template` passes `input` to `Templates.render()`, so `card.pug` works and `card.png` throws `NotSupported`.
- **Template mode serves the template's directory.** Relative URLs resolve through the injected `<base href>`; the template model has no `__http_template_port__` key in this mode.
- **Every run launches a new Chromium.** The command disposes the renderer at the end; there is no warm browser between runs.

## Best practices

- Always pass `--width` and `--height` in CI so captures have the same size on every machine.
- Render raw HTML fixtures (no `--template`) for visual tests of CSS; render templates when the test covers the model and translations too.
- Keep fixtures and their assets in one directory: it becomes the asset server's root.

## Examples

### Visual regression in CI

```sh
# Render the fixture at a fixed viewport, then compare with the committed baseline
spinajs render-image test/fixtures/invoice.html -o .tmp/invoice.png --width 1024 --height 1448
npx pixelmatch .tmp/invoice.png test/baselines/invoice.png .tmp/invoice-diff.png 0.1
```

### Preview a translated template at retina scale

```sh
spinajs render-image templates/welcome.pug -t -m fixtures/welcome.json -l pl -o .tmp/welcome-pl.jpeg --type jpeg --width 600 --height 400 --scale 2
```

## Related

- [Image renderer](01-image-renderer.md): `renderHtmlToFile()`, which the command calls.
- [Configuration](02-configuration.md): the browser and timeout settings the command uses.
- [`@spinajs/cli`](../cli/README.md): command discovery, options and your own CLI entry point.
- [`@spinajs/templates`](../templates/README.md): `resolveInputHtml`, `cliProgressReporter`, `ensureParentDir`.
