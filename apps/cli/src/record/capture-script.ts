/** The page calls this binding with one event object (exposed with `handle: true`). */
export const CAPTURE_BINDING = '__demoflowRecord';
/** The page exposes this to switch its mode: `window.__demoflowRecordMode(mode)`. */
export const MODE_SETTER = '__demoflowRecordMode';
/**
 * The page exposes this to hand over the element of an event, once:
 * `window.__demoflowRecordTake(elementId)`. Bindings carry JSON only.
 */
export const ELEMENT_TAKER = '__demoflowRecordTake';

/**
 * What the recorder is doing with the next gesture in the app's page.
 * `pick-*` and `hover` stop the click before the page sees it.
 */
export type CaptureMode =
  | 'record'
  | 'pick-visible'
  | 'pick-text'
  | 'hover'
  | 'secret-next';

/** Locator material the page collects; the recorder verifies each with Playwright. */
export interface Candidates {
  role?: string;
  labels: string[];
  placeholder?: string;
  testId?: string;
  text?: string;
  css: string;
}

/** An event as the page sends it; its element is taken by `elementId`. */
export type CaptureEvent = CaptureEventBody & { elementId?: number };

type CaptureEventBody =
  | { type: 'hello' }
  | { type: 'click'; candidates: Candidates }
  | { type: 'pick'; candidates: Candidates; text: string }
  | {
      type: 'fill';
      candidates: Candidates;
      /** Absent for a secret: the value never leaves the page. */
      value?: string;
      secret: boolean;
      /** The same for every event of one field in one document. */
      field: string;
    }
  | { type: 'select'; candidates: Candidates; option: string }
  | { type: 'press'; candidates: Candidates; key: string }
  | {
      type: 'scroll';
      atTop: boolean;
      atBottom: boolean;
      candidates?: Candidates;
    };

/**
 * The init script of the app's context. Plain JavaScript in a string: it runs
 * in the page, and a bundler must not rewrite it. Its only footprint on the
 * page is event listeners and the mode setter — nothing is drawn (spec #79).
 *
 * The value of a password field, or of the field marked secret from the panel,
 * is never read: the event carries `secret: true` and no value. Keys pressed
 * in such a field are not sent at all.
 */
export const CAPTURE_SCRIPT = `(() => {
  if (window.top !== window || window.${MODE_SETTER}) return;
  let mode = 'record';
  const secrets = new WeakSet();
  const held = new Map();
  let nextId = 0;
  // A field keeps its id while the document lives; the token keeps ids of
  // different documents apart.
  const documentToken = Math.random().toString(36).slice(2);
  const fields = new WeakMap();
  let nextField = 0;
  const fieldOf = (el) => {
    if (!fields.has(el)) {
      nextField += 1;
      fields.set(el, documentToken + ':' + nextField);
    }
    return fields.get(el);
  };
  const send = ({ element, ...event }) => {
    if (element) {
      nextId += 1;
      held.set(nextId, element);
      event.elementId = nextId;
    }
    return window.${CAPTURE_BINDING}(event);
  };
  Object.defineProperty(window, '${MODE_SETTER}', {
    value: (next) => { mode = next; },
  });
  Object.defineProperty(window, '${ELEMENT_TAKER}', {
    value: (id) => { const element = held.get(id); held.delete(id); return element || null; },
  });

  const TEXT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week'];
  const CLICKABLE = 'button, a[href], input, select, textarea, summary, label, ' +
    '[role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], ' +
    '[role=menuitemradio], [role=checkbox], [role=radio], [role=switch], [role=option], ' +
    '[role=treeitem], [role=combobox], [onclick]';
  const PICKABLE = CLICKABLE + ', h1, h2, h3, h4, h5, h6, [role=heading], p, li, td, th, ' +
    'dt, dd, img, figcaption, [role=alert], [role=status], [role=dialog], [role=cell]';

  const isTextField = (el) =>
    (el instanceof HTMLInputElement && TEXT_TYPES.includes(el.type)) ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable);
  const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();

  function implicitRole(el) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : undefined;
      case 'button': return 'button';
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return el.getAttribute('alt') === '' ? undefined : 'img';
      case 'li': return 'listitem';
      case 'td': return 'cell';
      case 'th': return 'columnheader';
      case 'tr': return 'row';
      case 'table': return 'table';
      case 'nav': return 'navigation';
      case 'dialog': return 'dialog';
      case 'option': return 'option';
      case 'p': return 'paragraph';
      case 'input':
        switch (el.type) {
          case 'button': case 'submit': case 'reset': case 'image': return 'button';
          case 'checkbox': return 'checkbox';
          case 'radio': return 'radio';
          case 'range': return 'slider';
          case 'number': return 'spinbutton';
          case 'search': return el.hasAttribute('list') ? 'combobox' : 'searchbox';
          case 'email': case 'tel': case 'text': case 'url': case '':
            return el.hasAttribute('list') ? 'combobox' : 'textbox';
          default: return undefined;
        }
      default: return undefined;
    }
  }

  function labelsOf(el) {
    const labels = [];
    const aria = normalize(el.getAttribute('aria-label'));
    if (aria) labels.push(aria);
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
    const byId = normalize(ids.map((id) => document.getElementById(id)?.textContent).join(' '));
    if (byId) labels.push(byId);
    for (const label of el.labels || []) {
      const text = normalize(label.textContent);
      if (text) labels.push(text);
    }
    return labels;
  }

  function cssPath(el) {
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.localName === node.localName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    return parts.join(' > ');
  }

  function candidates(el) {
    const text = normalize(el instanceof HTMLElement ? el.innerText : el.textContent);
    return {
      role: normalize(el.getAttribute('role')).split(' ')[0] || implicitRole(el),
      labels: labelsOf(el),
      placeholder: el.getAttribute('placeholder') || undefined,
      testId: el.getAttribute('data-testid') || undefined,
      text: text && text.length <= 80 ? text : undefined,
      css: cssPath(el),
    };
  }

  const pickTarget = (el) => el.closest(PICKABLE) || el;

  // Pick, hover: the gesture is the recorder's, the page never sees it.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
    'dblclick', 'auxclick', 'contextmenu']) {
    window.addEventListener(type, (event) => {
      if (mode !== 'pick-visible' && mode !== 'pick-text' && mode !== 'hover') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type !== 'click' || !(event.target instanceof Element)) return;
      const el = mode === 'hover' ? event.target.closest(CLICKABLE) || event.target : pickTarget(event.target);
      send({ type: 'pick', element: el, candidates: candidates(el),
        text: normalize(el instanceof HTMLElement ? el.innerText : el.textContent) });
    }, true);
  }

  window.addEventListener('click', (event) => {
    if (mode !== 'record' && mode !== 'secret-next') return;
    if (!(event.target instanceof Element)) return;
    const el = event.target.closest(CLICKABLE) || event.target;
    // Typing and choosing are recorded as fill and select, which click themselves.
    if (isTextField(el) || el instanceof HTMLSelectElement || el.closest('select')) return;
    // A label passes the click on to its control, which is recorded instead.
    if (el instanceof HTMLLabelElement && el.control) return;
    send({ type: 'click', element: el, candidates: candidates(el) });
  }, true);

  window.addEventListener('input', (event) => {
    const el = event.target;
    if (!(el instanceof Element) || !isTextField(el)) return;
    if (mode === 'secret-next') secrets.add(el);
    const secret = (el instanceof HTMLInputElement && el.type === 'password') || secrets.has(el);
    const field = fieldOf(el);
    send(secret
      ? { type: 'fill', element: el, candidates: candidates(el), secret: true, field }
      : { type: 'fill', element: el, candidates: candidates(el), secret: false, field,
          value: el.isContentEditable ? el.innerText : el.value });
  }, true);

  // Keys that act on a text field without typing into it. Typing stays fill.
  const PRESS_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  window.addEventListener('keydown', (event) => {
    if (mode !== 'record' || !PRESS_KEYS.includes(event.key)) return;
    if (event.repeat || event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const el = event.target;
    if (!(el instanceof Element) || !isTextField(el)) return;
    // Never a key inside a secret field: not even that one was pressed.
    if ((el instanceof HTMLInputElement && el.type === 'password') || secrets.has(el)) return;
    // Enter in a multi-line field types a newline.
    if (event.key === 'Enter' && (el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
    send({ type: 'press', element: el, candidates: candidates(el), key: event.key });
  }, true);

  window.addEventListener('change', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLSelectElement)) return;
    const option = el.selectedOptions[0];
    if (!option) return;
    send({ type: 'select', element: el, candidates: candidates(el), option: normalize(option.label) });
  }, true);

  let lastY = window.scrollY;
  let settle;
  window.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (Math.abs(window.scrollY - lastY) < 2) return;
      lastY = window.scrollY;
      const root = document.scrollingElement || document.documentElement;
      const atTop = window.scrollY <= 0;
      const atBottom = window.innerHeight + window.scrollY >= root.scrollHeight - 2;
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 4);
      const el = hit ? pickTarget(hit) : undefined;
      send({ type: 'scroll', atTop, atBottom, element: el,
        candidates: el ? candidates(el) : undefined });
    }, 400);
  }, { passive: true });

  // A new document asks which mode the session is in.
  send({ type: 'hello' }).then((current) => { if (current) mode = current; }, () => {});
})();`;
