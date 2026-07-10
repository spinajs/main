# @spinajs/templates-puppeteer

Base Puppeteer renderer for SpineJS templates. This package provides shared logic for rendering templates using Puppeteer.

## Installation

``bash
npm install @spinajs/templates-puppeteer
``

## Render progress

PDF/image renders can take a long time when the HTML pulls in many external
resources (images, fonts, stylesheets). Pass an `onProgress` callback to observe
what the render is doing - especially while resources are loading.

Progress is reported through discrete phases (`starting` → `preparing` →
`loading` → `rendering` → `done`, or `failed`) with a best-effort `percent`,
live resource counters, and elapsed time. The callback is fire-and-forget: it is
never awaited and its errors are swallowed, so it can neither slow nor break a
render. Emissions are throttled, with a heartbeat during the long phases so the
value keeps moving even when a single resource is slow.

``ts
await pdfRenderer.renderToFile('invoice.pdf', model, 'out/invoice.pdf', 'en', {
  onProgress: (p) => {
    // p: { phase, percent, resourcesLoaded, resourcesPending, resourcesFailed, elapsedMs, filePath, message }
    console.log(`${p.phase} ${p.percent}% - ${p.message}`);
  },
});
``

The same option works on `renderHtmlToFile(html, filePath, { onProgress })` and
flows through the `Templates` facade (`render` / `renderToFile` / `compile` /
`compileToFile`). The CLI commands `render-pdf` / `render-image` already render a
live progress line via the shared `cliProgressReporter()`.

Reporting progress from a queue job is a one-liner - forward the percentage:

``ts
await templates.renderToFile('report.pdf', model, out, lang, {
  onProgress: (p) => void jobProgress(p.percent),
});
``
