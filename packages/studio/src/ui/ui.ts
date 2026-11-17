import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response } from '@spinajs/http';
import { configuredMountPath, withRoutePrefix } from '@spinajs/manifest';

// worker-src blob: and the data: sources are needed by the ckit-graph ELK worker and ckit's inline icons (owner OD5).
export const STUDIO_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'";
export const UI_PACKAGE = '@spinajs/studio-ui';
export const UI_MISSING = `Spina Studio UI is not installed: install ${UI_PACKAGE} from the coderush GitLab registry (map the @spinajs scope to the coderush group endpoint), or set studio.ui.path to an unpacked dist/ directory`;

// private: the bundle is served behind the access policy, so a shared cache must not keep it.
const IMMUTABLE = 'private, max-age=31536000, immutable';

/** The only file types served from dist/; a file of any other type answers 404. */
export const UI_CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.wasm', 'application/wasm'],
]);

type ExpressResponse = Parameters<Response['execute']>[1];

/**
 * The dist/ directory holding `index.html`, as {@link realPath} gives it, so a served file is compared against the
 * real directory.
 */
export function locateUi(configured: string | undefined): string | undefined {
  if (configured) return existsSync(join(configured, 'index.html')) ? realPath(resolvePath(configured)) : undefined;
  try {
    return realPath(dirname(fileURLToPath(import.meta.resolve(`${UI_PACKAGE}/dist/index.html`))));
  } catch {
    return undefined;
  }
}

export function servedBase(path: string, prefix: string | undefined): string {
  const mount = configuredMountPath(path);
  return withRoutePrefix(prefix, mount === '/' ? '/' : `/${mount}`).replace(/\/+$/, '');
}

const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** What the router puts before every controller path: '' without `http.controllers.route.prefix`, else e.g. '/api'. */
export function appBase(prefix: string | undefined): string {
  return withRoutePrefix(prefix, '').replace(/\/+$/, '');
}

/**
 * `base` is where Studio is served (prefix included), `app` where every other controller of the app is: the UI calls
 * its own API under the first and telemetry or scheduler-http under the second.
 */
export function withStudioBase(html: string, base: string, app: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) throw new Error('the Studio UI index.html has no <head>');
  const at = head.index + head[0].length;
  const injected = `<base href="${attr(base)}/"><meta name="spina-studio-base" content="${attr(base)}"><meta name="spina-app-base" content="${attr(app)}">`;
  return `${html.slice(0, at)}${injected}${html.slice(at)}`;
}

const unsafeSegment = (segment: string): boolean => segment.startsWith('.') || /[/\\\0]/.test(segment);

/**
 * The decoded segments of a request path below the Studio base, passed percent-encoded as `req.path` keeps it. Each
 * segment is decoded on its own, so an encoded `/` or `\` cannot join two of them. Undefined for a path that could
 * leave dist/ or name a hidden file: a dot segment, a name starting with a dot, a separator or NUL byte inside a
 * segment, or a malformed escape.
 */
export function uiSegments(raw: string): string[] | undefined {
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (unsafeSegment(segment)) return undefined;
    segments.push(segment);
  }
  return segments;
}

/**
 * Links followed, and on Windows 8.3 short names expanded, letter case corrected and an `::$DATA` stream suffix
 * dropped: the JS `realpathSync` does none of the last three, so `SECRET~1.JS` would pass as a name without a dot.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Node documents that the native call fails on some virtual and RAM drives; short names stay unexpanded there.
    return realpathSync(path);
  }
}

/**
 * The file of dist/ that `path` (decoded, `/`-separated) names, as {@link realPath} gives it.
 *
 * Null when the path itself must not be served (a segment `uiSegments` refuses, an absolute path): decided before
 * the disk is read. Undefined when no file may be served, so the caller falls back to `index.html`: no such file, or
 * one whose real path is outside `root` (a link), names a hidden file or directory, or has a type outside
 * {@link UI_CONTENT_TYPES}. Those are answered like a missing file, so the answer never tells that a file exists.
 */
export function assetFile(root: string, path: string): string | null | undefined {
  if (isAbsolute(path) || path.split('/').some(unsafeSegment)) return null;
  const file = join(root, path);
  if (!inside(root, file)) return null;
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  const real = realPath(file);
  const servable = inside(root, real) && !relative(root, real).split(sep).some((segment) => segment.startsWith('.')) && UI_CONTENT_TYPES.has(extname(real).toLowerCase());
  return servable ? real : undefined;
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export class StudioPageResponse extends Response {
  public constructor(private readonly html: string) {
    super(null);
  }

  public async execute(_req: unknown, res: ExpressResponse): Promise<void> {
    res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': STUDIO_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(this.html);
  }
}

export class StudioAssetResponse extends Response {
  /** `root` and `file` are real paths, `file` inside `root`, as {@link assetFile} returns it. */
  public constructor(private readonly root: string, private readonly file: string, private readonly hashed: boolean) {
    super(null);
  }

  public async execute(_req: unknown, res: ExpressResponse): Promise<void> {
    const headers = {
      'Content-Type': UI_CONTENT_TYPES.get(extname(this.file).toLowerCase()),
      'Cache-Control': this.hashed ? IMMUTABLE : 'no-cache',
      'Content-Security-Policy': STUDIO_CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    await new Promise<void>((resolve, reject) => {
      // root: send checks only the part below it (an absolute path under `.claude` or `~/.local` would be refused as
      // a dot segment). cacheControl: false keeps send from writing its own Cache-Control beside ours.
      res.sendFile(relative(this.root, this.file), { root: this.root, headers, cacheControl: false, dotfiles: 'deny', index: false }, (err?: Error & { code?: string }) => {
        if (err && !res.headersSent && err.code !== 'ECONNABORTED') reject(err);
        else resolve();
      });
    });
  }
}
