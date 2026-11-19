/** Defines `name` on `target` where jsdom has none. */
function provide<T extends object, K extends keyof T>(target: T, name: K, value: T[K]): void {
  if (!(name in target)) Object.defineProperty(target, name, { configurable: true, writable: true, value });
}

/** Browser APIs jsdom lacks and ckit touches: matchMedia (theme), ResizeObserver (dashboard, grid), scrollIntoView (tree), popovers and modal dialogs. */
export function stubBrowserApis(): void {
  provide(window, 'matchMedia', (query: string): MediaQueryList => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
  provide(
    globalThis,
    'ResizeObserver',
    class implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  provide(Element.prototype, 'scrollIntoView', function scrollIntoView() {});

  // Ported from ckit packages/components/src/test/top-layer.ts: jsdom hides a [popover] that is not :popover-open.
  if (!('showPopover' in HTMLElement.prototype)) {
    Object.assign(HTMLElement.prototype, {
      showPopover(this: HTMLElement) {
        this.dataset.shown = '';
      },
      hidePopover(this: HTMLElement) {
        delete this.dataset.shown;
      },
    });
    const style = document.createElement('style');
    style.textContent = '[popover][data-shown] { display: block !important }';
    document.head.append(style);
  }
  provide(HTMLDialogElement.prototype, 'showModal', function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  provide(HTMLDialogElement.prototype, 'show', function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  provide(HTMLDialogElement.prototype, 'close', function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event('close'));
  });
}
