# @spinajs/templates-image

Template renderer for generating images using Puppeteer.

## Documentation

- [Package overview](../../docs/templates-image/README.md)
- [Image renderer](../../docs/templates-image/01-image-renderer.md)
- [Configuration](../../docs/templates-image/02-configuration.md)
- [`render-image` command](../../docs/templates-image/03-render-image-command.md)
- [Custom image renderers](../../docs/templates-image/04-custom-image-renderers.md)

## Installation

```bash
npm install @spinajs/templates-image
```

## Usage

This package extends `@spinajs/templates-puppeteer` to render templates as image files (PNG, JPEG, etc.).

```typescript
import { DI } from '@spinajs/di';
import { ImageRenderer } from '@spinajs/templates-image';

const renderer = await DI.resolve(ImageRenderer, [{ type: 'png', fullPage: true }]);

// the renderer's extension replaces the template's: 'template.png' reads 'template.pug'
await renderer.renderToFile('template.png', { data: 'example' }, 'output.png');
```

## Configuration

Configure via `templates.image` in your SpineJS configuration:

```javascript
{
  templates: {
    image: {
      static: {
        portRange: [3000, 4000]
      },
      args: {
        headless: true
      },
      renderDurationWarning: 5000,
      navigationTimeout: 30000,
      renderTimeout: 30000
    }
  }
}
```

## License

MIT
