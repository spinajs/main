/**
 * Where a rendered PDF is written - a named @spinajs/fs provider and a path
 * relative to that provider's base.
 */
export interface IRenderOutput {
  /** Configured @spinajs/fs provider name (local / temp / s3 / ...). */
  provider: string;
  /** Destination path relative to the provider base. */
  path: string;
}

/**
 * A single PDF render request handed to the worker process.
 */
export interface IRenderRequest {
  /** Template path (template mode) or a raw HTML string. */
  input: string;
  /** When true, `input` is a template rendered via the text engine by extension; otherwise it is raw HTML. */
  template?: boolean;
  /** Model passed to the template (template mode). */
  model?: unknown;
  /** Optional language (template mode). */
  lang?: string;
  /** Where to write the resulting PDF. */
  output: IRenderOutput;
  /** Puppeteer PDF options (format, landscape, scale, ...). */
  pdfOptions?: Record<string, unknown>;
  /** Directory served over the local http server so relative asset URLs resolve (raw HTML mode). */
  assetBasePath?: string;
  /**
   * Optional inline configuration for the worker. When present it is used to
   * bootstrap the worker's Configuration; otherwise the worker resolves the
   * ambient app Configuration (re-bootstrap model).
   */
  config?: unknown;
}

/** Messages the worker sends back to its parent over the IPC channel. */
export type WorkerMessage =
  | { type: 'progress'; percent: number; phase: string; message?: string }
  | { type: 'done'; result: IRenderOutput }
  | { type: 'error'; message: string };
