# Configuration

`templates.image` controls how `ImageRenderer` launches Chromium, serves assets and times out. The package ships defaults in `lib/<mjs|cjs>/config/image.js`; your config files merge over them.

## How it works

1. `@spinajs/configuration` loads the package config file from `node_modules/@spinajs/templates-image/lib/<mjs|cjs>/config` with every other package config, then your app's files ([Config files](../configuration/03-config-files.md)).
2. `ImageRenderer.Options` is a `@Config('templates.image')` getter: every read returns the current value of the section.
3. `PuppeteerRenderer` reads `static.portRange` when it starts the asset server, timeouts and `debug.close` when a render starts, and `renderDurationWarning` when it ends. Changes apply from the next render.
4. `args` and `executablePath` are read when `BrowserPool` launches Chromium: on the first render, after a crash, or after `dispose()`. A change does not affect a browser that is already running.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `templates.image.static.portRange` | `number[]` | `[3000, 4000]` | `[min, max]`, or `[]` | Port range of the per-render asset server. A random port in the range is tried up to 10 times on `EADDRINUSE`. With `[]` or no key the OS assigns a free port. |
| `templates.image.args` | Puppeteer `LaunchOptions` | `{ headless: true }` | Any `puppeteer.launch()` option | Passed to `puppeteer.launch()`. `args.args` holds Chromium command-line flags. |
| `templates.image.executablePath` | `string` | not set | Path to a Chrome or Chromium binary | Overrides `args.executablePath`. Use it when Puppeteer cannot download Chromium. |
| `templates.image.renderDurationWarning` | `number` (ms) | `5000` | Positive number | A render that takes longer logs `Rendering to file ... took too long.` at `warn`. |
| `templates.image.navigationTimeout` | `number` (ms) | `30000` | Positive number | `page.setDefaultNavigationTimeout()`. `0` or no value falls back to `30000`. |
| `templates.image.renderTimeout` | `number` (ms) | `30000` | Positive number | `page.setDefaultTimeout()` and the watchdog that closes the page when a render runs longer. `0` or no value falls back to `30000`. |
| `templates.image.debug.close` | `boolean` | not set (pages close) | `false` | `false` keeps each page open after the render and disarms timeouts and the watchdog. Combine with `args.headless: false` to inspect the page. |
| `system.dirs.cli` | `string[]` | this package's `lib/<mjs|cjs>/cli` under `WORKSPACE_ROOT_PATH ?? cwd`, and the same path one directory up | Absolute paths | Appended so `@spinajs/cli` finds the `render-image` command. |

The package config file:

```js
export default {
  templates: {
    image: {
      static: { portRange: [3000, 4000] },
      args: { headless: true },
      renderDurationWarning: 5000,
      navigationTimeout: 30000,
      renderTimeout: 30000,
    },
  },
};
```

Your app's `config/templates.js`, for a container image with a system Chromium:

```js
export default {
  templates: {
    image: {
      executablePath: '/usr/bin/chromium',
      // Chromium flags; the package sets none
      args: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      renderTimeout: 60000,
      renderDurationWarning: 10000,
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Renderer options | Config section `templates.image`, read through the `@Config` getter `ImageRenderer.Options` (type `IPuppeteerRendererOptions` from `@spinajs/templates-puppeteer`) | The package config file | `templates.pdf` for `PdfRenderer` | Override keys in your config files; redeclare `Options` with another `@Config` path in a subclass to give it its own section ([Custom image renderers](04-custom-image-renderers.md#give-a-renderer-its-own-config-section)) |

## Important behaviour

- **Arrays concatenate across config files.** Your `static.portRange: [8080, 8090]` becomes `[3000, 4000, 8080, 8090]`, and only the first two entries count. Replace the range with `set()` in a `configure()` hook (see the example below).
- **The default is a fixed range, not an OS port.** Two processes rendering at once pick from the same 1001 ports and retry on collisions. Set the range to `[]` to let the OS choose.
- **`0` does not disable a timeout.** It falls back to `30000`. Only `debug.close: false` disables timeouts.
- **`debug.close: false` leaks pages.** Pages are never closed and renders never time out. Use it only on a developer machine.
- **No schema validates this section.** A typo in a key is ignored silently.

## Best practices

- Keep `headless: true` in production; turn it off only together with `debug.close: false`.
- Add `--no-sandbox` only where Chromium runs as root in a container, and `--disable-dev-shm-usage` where `/dev/shm` is small.
- Raise `renderDurationWarning` to match your slowest expected template, so the warning means something.

## Patterns and antipatterns

```js
// Don't: arrays concatenate, the package range [3000, 4000] still wins
export default { templates: { image: { static: { portRange: [8080, 8090] } } } };

// Do: replace the array after the merge
export default {
  templates: {
    configure() {
      this.set('templates.image.static.portRange', []);
    },
  },
};
```

## Examples

### Inspect a broken template in a visible browser

`config/templates.development.js`:

```js
export default {
  templates: {
    image: {
      args: { headless: false, devtools: true },
      debug: { close: false },
    },
  },
};
```

Run the render; the Chromium window stays open on the rendered page.

### Change the timeout from code before rendering

```ts sample
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Templates } from '@spinajs/templates';
import '@spinajs/templates-image';

async function renderAnnualReportCover(year: number): Promise<void> {
  const configuration = await DI.resolve(Configuration);

  // The cover loads large photos; give it two minutes. Read on the next render.
  configuration.set('templates.image.renderTimeout', 120000);
  configuration.set('templates.image.static.portRange', []);

  const templates = await DI.resolve(Templates);
  await templates.renderToFile('templates/reports/cover.png', { year }, `out/report-${year}-cover.png`);
}

void renderAnnualReportCover(2026);
```

## Related

- [Image renderer](01-image-renderer.md): the renderer that reads this section.
- [Config files](../configuration/03-config-files.md): where package and app config files are loaded from.
- [Configuration service](../configuration/01-configuration-service.md): merge rules, `set()` and `configure()` hooks.
- [`@spinajs/templates-puppeteer`](../templates-puppeteer/README.md): `IPuppeteerRendererOptions`, shared with `templates.pdf`.
