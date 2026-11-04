const MAX_SVG_BYTES = 512 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';
const REQUIRED_IDS = ['hour-hand', 'minute-hand', 'second-hand'] as const;

/** Elements that can execute script, host HTML, or pull in remote content. */
const FORBIDDEN_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'image',
]);

export type SanitizeResult = { ok: true; markup: string } | { ok: false; reason: string };

/**
 * Parses, sanitizes, and validates an SVG skin.
 *
 * Rules: no script/HTML embedding elements, no event-handler attributes, no
 * `javascript:`/`vbscript:` payloads, and no references outside the file itself
 * (`href` must be a local `#id`, `url()` must be local). The returned markup is the
 * only markup that may be passed to `dangerouslySetInnerHTML`.
 */
export function sanitizeSvg(raw: string): SanitizeResult {
  if (raw.length > MAX_SVG_BYTES) {
    return { ok: false, reason: 'file is larger than 512 KiB' };
  }

  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  if (doc.querySelector('parsererror')) {
    return { ok: false, reason: 'file is not valid XML' };
  }

  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    return { ok: false, reason: 'root element must be <svg>' };
  }
  if (!root.getAttribute('viewBox')) {
    return { ok: false, reason: 'missing a viewBox attribute (the hands rotate around its centre)' };
  }

  sanitizeTree(doc, root);

  for (const id of REQUIRED_IDS) {
    if (!root.querySelector(`#${id}`)) {
      return { ok: false, reason: `missing a #${id} element` };
    }
  }

  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  root.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  return { ok: true, markup: new XMLSerializer().serializeToString(root) };
}

function sanitizeTree(doc: Document, root: Element): void {
  const elements: Element[] = [root];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element) elements.push(node);
  }

  for (const element of elements) {
    // Forbidden containers are removed with their subtree; skip anything detached.
    if (element !== root && !element.isConnected) continue;

    const name = element.localName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(name)) {
      element.remove();
      continue;
    }

    if (name === 'style') {
      element.textContent = sanitizeCss(element.textContent ?? '');
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.localName.toLowerCase();
      const value = attribute.value;

      if (attributeName.startsWith('on') || isDangerousValue(value) || hasExternalUrl(value)) {
        element.removeAttributeNode(attribute);
        continue;
      }

      // Any remaining href/src must point inside this document.
      if ((attributeName === 'href' || attributeName === 'src') && !value.trim().startsWith('#')) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}

function isDangerousValue(value: string): boolean {
  // Strip whitespace and control characters so `java\nscript:` is caught too.
  const compact = value.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  return (
    compact.includes('javascript:') ||
    compact.includes('vbscript:') ||
    compact.includes('data:text/html')
  );
}

function hasExternalUrl(value: string): boolean {
  const pattern = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
  let match = pattern.exec(value);
  while (match !== null) {
    const target = (match[2] ?? '').trim();
    if (!target.startsWith('#')) return true;
    match = pattern.exec(value);
  }
  return false;
}

function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'none(')
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match: string, _quote: string, target: string) =>
      target.trim().startsWith('#') ? match : 'none',
    );
}
