/* Link tokens for dropped files, folders and URLs. Pure functions (no DOM), shared by the composer
   and the chat bubbles; also loadable from Node for checks. The engine always sees the plain
   deterministic text form "[Datei: C:\…]" / "[Ordner: …]" / "[Link: https://…]". */
(function (root) {
  const KINDS = ['Datei', 'Ordner', 'Link'];
  const ALIASES = {
    Datei: 'Datei',
    Ordner: 'Ordner',
    Link: 'Link',
    File: 'Datei',
    Folder: 'Ordner',
    file: 'Datei',
    folder: 'Ordner',
    link: 'Link',
    datei: 'Datei',
    ordner: 'Ordner',
  };
  function canonicalKind(k) {
    return ALIASES[k] || (KINDS.includes(k) ? k : null);
  }

  const ICONS = { Datei: '📄', Ordner: '📁', Link: '🔗' };
  const CLASSES = { Datei: 'ref-file', Ordner: 'ref-dir', Link: 'ref-link' };
  const TOKEN_RE = /\[(Datei|Ordner|Link|File|Folder): ([^\]\n]+)\]/gi;
  const MAX_LABEL = 40;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cap = (s) => (s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s);

  /** Short visible name: last path segment, or host + last URL segment. */
  function refLabel(kind, target) {
    const ck = canonicalKind(kind) || kind;
    if (ck === 'Link') {
      try {
        const u = new URL(target);
        const last = u.pathname.split('/').filter(Boolean).pop();
        let seg = '';
        try { seg = last ? decodeURIComponent(last) : ''; } catch { seg = last || ''; }
        return cap(seg ? `${u.hostname} › ${seg}` : u.hostname);
      } catch {
        return cap(target);
      }
    }
    const trimmed = String(target).replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\'; // drive root
    const last = trimmed.split(/[\\/]/).filter(Boolean).pop();
    return cap(last || target);
  }

  /** Text form sent to the engine, or null if the target cannot be expressed as a token. */
  function refToken(kind, target) {
    const ck = canonicalKind(kind);
    if (!ck || !target || /[\]\n]/.test(target)) return null;
    return `[${ck}: ${target}]`;
  }

  const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);

  /** Escape a sent message and turn its tokens into clickable link elements. */
  function renderRefs(text) {
    let out = '';
    let last = 0;
    for (const m of String(text).matchAll(TOKEN_RE)) {
      const [whole, rawKind, target] = m;
      const ck = canonicalKind(rawKind) || 'Datei';
      out += esc(text.slice(last, m.index));
      out += `<a class="ref ${CLASSES[ck] || 'ref-file'}" data-kind="${ck}" data-target="${esc(target)}" title="${esc(target)}">${ICONS[ck] || '📄'} ${esc(refLabel(ck, target))}</a>`;
      last = m.index + whole.length;
    }
    return out + esc(String(text).slice(last));
  }

  const api = { KINDS, ICONS, CLASSES, canonicalKind, refLabel, refToken, renderRefs, isUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.refs = api;
})(typeof window !== 'undefined' ? window : globalThis);
