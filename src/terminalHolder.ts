// A single off-screen DOM node that "parks" terminal instances whose pane is not
// currently visible (its tab is inactive, or it has exited). Keeping the xterm DOM
// mounted here — instead of unmounting it — keeps the underlying PTY process alive.
let holderEl: HTMLElement | null = null;

export function getTerminalHolder(): HTMLElement {
  if (!holderEl) {
    holderEl = document.createElement('div');
    holderEl.setAttribute('data-term-holder', '');
    holderEl.style.cssText =
      'position:fixed;left:-99999px;top:0;width:900px;height:560px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(holderEl);
  }
  return holderEl;
}
