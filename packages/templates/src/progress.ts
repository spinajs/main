/**
 * Milestones a (puppeteer) render passes through. Text engines complete
 * synchronously and do not report phases.
 */
export enum RenderPhase {
  /** Local static server + pooled browser + page are being set up. */
  Starting = 'starting',
  /** HTML is being built (template compiled / raw HTML injected) - before load. */
  Preparing = 'preparing',
  /** Page content is loading - external resources (images, css, fonts) downloading. */
  Loading = 'loading',
  /** The output is being produced (page.pdf() / screenshot). */
  Rendering = 'rendering',
  /** Render finished successfully. */
  Done = 'done',
  /** Render failed - `message` carries the reason. */
  Failed = 'failed',
}

/**
 * A single progress snapshot delivered to a {@link RenderProgressCallback}.
 * Resource counters are meaningful only for network-backed engines (puppeteer);
 * they stay at 0 otherwise.
 */
export interface IRenderProgress {
  /** Current render phase. */
  phase: RenderPhase;
  /** Best-effort completion, 0..100, weighted per phase. */
  percent: number;
  /** Resources whose response completed since loading started. */
  resourcesLoaded: number;
  /** Resources requested but not yet finished or failed. */
  resourcesPending: number;
  /** Resources that failed to load (e.g. broken images). */
  resourcesFailed: number;
  /** Milliseconds elapsed since the render started. */
  elapsedMs: number;
  /** Output file being produced. */
  filePath: string;
  /** Short human-readable status line. */
  message?: string;
}

/**
 * Progress listener. Invoked fire-and-forget by the renderer - it is never
 * awaited and any thrown error / rejected promise is swallowed, so a slow or
 * faulty listener can neither stall nor break a render. Emissions are throttled.
 */
export type RenderProgressCallback = (progress: IRenderProgress) => void | Promise<void>;

/**
 * Optional per-render options threaded through the {@link TemplateRenderer}
 * contract and the {@link Templates} facade. All fields are optional; engines
 * that do not support a given field ignore it.
 */
export interface IRenderOptions {
  /** Receives throttled progress updates during the render. */
  onProgress?: RenderProgressCallback;
}
