/* Termi – renderer. Plain JS on purpose (no build step for the UI).
   Talks to the engine only through window.termi (see preload.ts). */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.termi;
  const md = window.marked;
  const refs = window.refs;
  const i18n = window.i18n;
  const t = i18n.t;
  md.setOptions({ breaks: true, gfm: true });
  
  function translateUI() {
    const vars = { agent: state.agentName || 'Assistant' };
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (el.dataset.placeholder !== undefined) {
        el.dataset.placeholder = t(key, vars);
      } else if (el.id === 'send') {
        el.title = t(key, vars); // keep the ➤ icon, only translate the tooltip
      } else {
        el.textContent = t(key, vars);
      }
    });
    if (state.ready) {
      renderQuick();
    }
  }

  // ---------- state ----------
  const state = {
    view: 'chat',
    persona: 'standard',
    approvalMode: 'safe',
    dir: null,
    busy: false,
    ready: false,
    current: null,          // current assistant bubble { el, body, raw }
    activities: new Map(),  // tool_use id -> activity element
    unseenTerminal: 0,
    engineSkills: [],       // skills the engine reported in 'init' (Claude SDK)
    workspaceSkills: [],    // skills found in the workspace's SKILL.md folders (fallback)
  };

  // No hardcoded TOOL_LABELS here anymore.

  // The Skill menu: key -> i18n keys
  const SKILLS = [
    { skill: 'create-ticket-dsw', key: 'ticket' },
    { skill: 'update-ticket', key: 'update_ticket' },
    { skill: 'create-status-report', key: 'status' },
    { skill: 'create-vcycle-report', key: 'vcycle' },
    { skill: 'write-document', key: 'doc' },
    { skill: 'review-document', key: 'review' },
    { skill: 'create-spreadsheet', key: 'excel' },
    { skill: 'review-spreadsheet', key: 'review_excel' },
    { skill: 'setup', key: 'setup' },
  ];

  const FILE_ICONS = { py: '🐍', md: '📝', txt: '📄', docx: '📘', doc: '📘', xlsx: '📗', xls: '📗', csv: '📊', pdf: '📕', json: '🧾', yaml: '🧾', yml: '🧾', jpeg: '🖼️', jpg: '🖼️', png: '🖼️', svg: '🖼️', ps1: '⚙️', js: '📜', ts: '📜', html: '🌐', zip: '🗜️' };

  const now = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  // ---------- views ----------
  function showView(view) {
    state.view = view;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    if (view === 'terminal') { state.unseenTerminal = 0; updateTerminalBadge(); }
    if (view === 'chat') $('input').focus();
  }
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  // ---------- status ----------
  function setStatus(cls, text) {
    const el = $('status');
    el.className = `status ${cls}`;
    $('status-text').textContent = text;
  }

  // ---------- chat rendering ----------
  const messages = $('messages');
  // Follow new output only while the user is at the bottom; scrolling up to read stops the jump.
  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  let chatPinned = true;
  messages.addEventListener('scroll', () => { chatPinned = atBottom(messages); });
  const scrollDown = (force = false) => {
    if (force) chatPinned = true;
    if (chatPinned) messages.scrollTop = messages.scrollHeight;
  };

  function addUser(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="avatar">👤</div><div><div class="bubble">${refs.renderRefs(text)}</div><div class="meta" style="justify-content:flex-end;margin-top:4px">${now()}</div></div>`;
    messages.appendChild(el);
    scrollDown(true);
  }

  function ensureAssistant() {
    if (state.current) return state.current;
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = `<div class="avatar">🤖</div><div class="bubble"><div class="meta"><b>${state.agentName || 'Assistant'}</b><span>${now()}</span></div><div class="md cursor"></div></div>`;
    messages.appendChild(el);
    state.current = { el, body: el.querySelector('.md'), raw: '', rendered: false };
    scrollDown();
    return state.current;
  }

  let renderQueued = false;
  function renderCurrent() {
    if (renderQueued || !state.current) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (!state.current) return;
      state.current.body.innerHTML = md.parse(state.current.raw);
      scrollDown();
    });
  }

  function finishAssistant() {
    if (!state.current) return;
    state.current.body.classList.remove('cursor');
    state.current.body.innerHTML = md.parse(state.current.raw);
    state.current = null;
    scrollDown();
  }

  function addActivity(ev) {
    const el = document.createElement('div');
    el.className = 'activity';
    el.innerHTML = `<span class="spin"></span><span>${esc(t('tool.' + ev.name))} · ${esc(ev.summary)}</span>`;
    messages.appendChild(el);
    state.activities.set(ev.id, el);
    scrollDown();
  }

  function finishActivity(ev) {
    const el = state.activities.get(ev.id);
    if (!el) return;
    el.classList.add('done');
    el.querySelector('.spin').textContent = ev.isError ? '✗' : '✓';
    state.activities.delete(ev.id);
  }

  // "Still working" line at the end of the chat: between answers the agent often thinks or waits
  // for a tool for 10 s and more, and without it the chat looks frozen.
  const WORKING_KEYS = { Read: 'reading', Glob: 'reading', Grep: 'reading', Write: 'writing', Edit: 'writing',
    Bash: 'tool', Skill: 'tool', WebFetch: 'web', WebSearch: 'web', Task: 'helper', Agent: 'helper' };
  let working = null;
  function showWorking(key = 'thinking') {
    if (!working) {
      const el = document.createElement('div');
      el.className = 'working';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="label"></span><span class="secs" aria-hidden="true"></span>';
      working = { el, since: Date.now(), timer: setInterval(tickWorking, 1000) };
    }
    working.el.querySelector('.label').textContent = t('working.' + key, {agent: state.agentName || 'Assistant'});
    messages.appendChild(working.el); // always the last line
    tickWorking();
    scrollDown();
  }
  function tickWorking() {
    if (!working) return;
    const s = Math.round((Date.now() - working.since) / 1000);
    working.el.querySelector('.secs').textContent = s >= 3 ? `${s} s` : '';
  }
  function hideWorking() {
    if (!working) return;
    clearInterval(working.timer);
    working.el.remove();
    working = null;
  }

  function addPermissionCard(ev) {
    const card = document.createElement('div');
    card.className = 'perm';
    card.dataset.requestId = ev.requestId;
    card.innerHTML = `
      <div class="perm-head">${t('perm.title')} <span class="tag">${esc(t('tool.' + ev.toolName))}</span></div>
      <div class="perm-summary">${esc(ev.summary)}</div>
      <details><summary>${t('perm.details')}</summary><pre>${esc(ev.detail || '')}</pre></details>
      <div class="perm-actions">
        <button class="btn primary" data-act="allow">${t('perm.allow')}</button>
        ${ev.canAlways ? `<button class="btn" data-act="always">${t('perm.allow_always')}</button>` : ''}
        <button class="btn danger" data-act="deny">${t('perm.deny')}</button>
        <span class="perm-state">${t('perm.waiting')}</span>
      </div>`;
    card.querySelectorAll('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        api.answerPermission(ev.requestId, act !== 'deny', act === 'always');
        resolvePermissionCard(ev.requestId, act !== 'deny');
      }),
    );
    messages.appendChild(card);
    scrollDown();
  }

  function resolvePermissionCard(requestId, allowed) {
    const card = messages.querySelector(`.perm[data-request-id="${CSS.escape(requestId)}"]`);
    if (!card) return;
    card.classList.add(allowed ? 'allowed' : 'denied');
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    card.querySelector('.perm-state').textContent = allowed ? `${t('perm.allowed')} · ${now()}` : `${t('perm.denied')} · ${now()}`;
  }

  // Errors also go into the chat: users who never open the Terminal view must see them.
  function addError(text) {
    const el = document.createElement('div');
    el.className = 'chat-error';
    el.setAttribute('role', 'alert');
    el.textContent = text;
    messages.appendChild(el);
    scrollDown(true);
  }

  function addTurnEnd(ev) {
    const el = document.createElement('div');
    el.className = 'turn-end';
    el.textContent = ev.isError ? t('turn.error', {s: (ev.durationMs / 1000).toFixed(1)}) : t('turn.done', {s: (ev.durationMs / 1000).toFixed(1)});
    messages.appendChild(el);
    scrollDown();
  }

  // File/folder/link tokens open locally (Alt = show in folder); links in answers open in the browser.
  function openRef(el, reveal) {
    const { kind, target } = el.dataset;
    if (kind === 'Link') api.openExternal(target);
    else if (reveal) api.reveal(target);
    else api.openPath(target);
  }
  messages.addEventListener('click', (e) => {
    const ref = e.target.closest('.ref[data-target]');
    if (ref) { e.preventDefault(); openRef(ref, e.altKey); return; }
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  // ---------- terminal ----------
  const terminal = $('terminal');
  const TERMINAL_MAX_LINES = 5000;
  let termPinned = true;
  terminal.addEventListener('scroll', () => { termPinned = atBottom(terminal); });
  function termLine(line, level) {
    const span = document.createElement('span');
    span.className = `t-${level === 'info' && line.startsWith('> ') ? 'user' : level}`;
    span.innerHTML = `<span class="t-time">${now()} </span>${esc(line)}\n`;
    terminal.appendChild(span);
    while (terminal.childElementCount > TERMINAL_MAX_LINES) terminal.firstElementChild.remove();
    if (termPinned) terminal.scrollTop = terminal.scrollHeight;
    if (state.view !== 'terminal') { state.unseenTerminal++; updateTerminalBadge(); }
  }
  function updateTerminalBadge() {
    const b = $('terminal-badge');
    b.hidden = state.unseenTerminal === 0;
    b.textContent = state.unseenTerminal > 99 ? '99+' : String(state.unseenTerminal);
  }
  $('terminal-clear').addEventListener('click', () => (terminal.textContent = ''));

  // ---------- composer: contenteditable with inline link tokens ----------
  // Dropped files/folders/URLs become non-editable <span class="ref"> tokens showing the short name;
  // serialize() turns them back into the "[Datei: C:\…]" text the engine gets.
  const input = $('input');
  const sendBtn = $('send');
  const composerResolved = $('composer-resolved');

  function updateResolvedPreview() {
    if (!composerResolved) return;
    const refEls = Array.from(input.querySelectorAll('.ref'));
    if (!refEls.length) {
      composerResolved.hidden = true;
      composerResolved.innerHTML = '';
      return;
    }
    composerResolved.innerHTML = '';
    refEls.forEach((el) => {
      const kind = el.dataset.kind || 'Datei';
      const target = el.dataset.target || '';
      const icon = refs.ICONS[kind] || '📄';
      const label = refs.refLabel(kind, target);
      const row = document.createElement('div');
      row.className = 'resolved-item';
      row.innerHTML = `<span class="resolved-icon">${icon}</span><span class="resolved-name">${esc(label)}</span><span class="resolved-arrow">→</span><span class="resolved-path" title="${esc(target)}">${esc(target)}</span>`;
      composerResolved.appendChild(row);
    });
    composerResolved.hidden = false;
  }

  function makeRef(kind, target) {
    const canonical = refs.canonicalKind ? refs.canonicalKind(kind) : kind;
    const span = document.createElement('span');
    span.className = `ref ${refs.CLASSES[canonical] || 'ref-file'}`;
    span.contentEditable = 'false';
    span.dataset.kind = canonical;
    span.dataset.target = target;
    span.title = `${target}\n${t('chat.ctrlClickOpen') || 'Strg+Klick öffnet'}`;
    span.textContent = `${refs.ICONS[canonical] || '📄'} ${refs.refLabel(canonical, target)}`;
    return span;
  }

  function serialize(node = input) {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.classList && n.classList.contains('ref')) out += refs.refToken(n.dataset.kind, n.dataset.target) || n.dataset.target;
      else if (n.nodeName === 'DIV' || n.nodeName === 'P') out += (out && !out.endsWith('\n') ? '\n' : '') + serialize(n);
      else out += serialize(n);
    });
    return out;
  }
  const composerText = () => serialize().replace(/\u00a0/g, ' ').trim();

  function placeCaret(range) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function caretToEnd() {
    const r = document.createRange();
    r.selectNodeContents(input);
    r.collapse(false);
    placeCaret(r);
  }
  function clearInput() {
    input.textContent = '';
    updateResolvedPreview();
  }
  function setText(text) {
    input.textContent = text;
    input.focus();
    caretToEnd();
    updateResolvedPreview();
  }
  const currentRange = () => { const sel = getSelection(); return sel.rangeCount ? sel.getRangeAt(0) : null; };
  const inInput = (r) => Boolean(r && input.contains(r.startContainer));

  /** Text in front of a position, to decide whether a separating space is needed. */
  function textBefore(range) {
    const r = document.createRange();
    r.setStart(input, 0);
    r.setEnd(range.startContainer, range.startOffset);
    return r.toString();
  }

  function insertNodes(nodes, range) {
    input.focus();
    if (!inInput(range)) {
      range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
    }
    const before = textBefore(range);
    if (before && !/\s$/.test(before)) nodes.unshift(document.createTextNode(' '));
    range.deleteContents();
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    const last = frag.lastChild;
    range.insertNode(frag);
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    placeCaret(after);
    updateResolvedPreview();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (!e.shiftKey) send();
    else if (!document.execCommand('insertLineBreak')) insertNodes([document.createElement('br')], currentRange());
  });
  // Paste as plain text only – no foreign HTML in the composer.
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData.getData('text/plain');
    if (t && !document.execCommand('insertText', false, t)) insertNodes([document.createTextNode(t)], currentRange());
    updateResolvedPreview();
  });
  // Chromium leaves a lone <br> once everything is deleted; remove it so the placeholder shows again.
  input.addEventListener('input', () => {
    if (!input.textContent && !input.querySelector('.ref')) input.innerHTML = '';
    updateResolvedPreview();
  });
  input.addEventListener('click', (e) => {
    const ref = e.target.closest('.ref');
    if (ref && (e.ctrlKey || e.metaKey)) openRef(ref, e.altKey);
  });
  sendBtn.addEventListener('click', () => (state.busy ? api.interrupt() : send()));

  function setBusy(busy) {
    state.busy = busy;
    sendBtn.classList.toggle('stop', busy);
    sendBtn.textContent = busy ? '■' : '➤';
    sendBtn.title = state.busy ? t('chat.stop') : t('chat.send');
    updateModelSelectState();
    setStatus(busy ? 'busy' : state.ready ? 'ready' : '', busy ? t('status.busy', {agent: state.agentName || 'Assistant'}) : state.ready ? t('status.ready') : t('status.starting'));
  }

  function send() {
    const text = composerText();
    if (!text || !state.ready) return;
    addUser(text);
    api.send(text);
    clearInput();
    setBusy(true);
    showWorking();
  }

  function prefill(phrase) {
    showView('chat');
    setText(phrase);
  }

  // Drag & drop: local paths are resolved by the app itself (no model call).
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    // If dropped outside the chat or explorer, prevent Electron from opening the file
    if (!e.defaultPrevented) e.preventDefault();
  });

  async function handleDrop(e) {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    // Insert where the item was dropped; otherwise at the caret; otherwise at the end.
    const atPoint = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    const point = inInput(atPoint) ? atPoint : inInput(currentRange()) ? currentRange() : null;

    const items = []; // { kind, target } or { text }
    const internal = dt.getData('application/x-termi-entry');
    let entry = null;
    try { entry = internal ? JSON.parse(internal) : null; } catch { entry = null; }
    if (entry && entry.path) {
      items.push({ kind: entry.isDir ? 'Ordner' : 'Datei', target: entry.path });
    } else if (dt.files && dt.files.length) {
      for (const f of Array.from(dt.files)) {
        const p = api.pathForFile(f);
        if (!p) continue;
        let isDir = false;
        try { isDir = (await api.statPath(p)).isDir; } catch { isDir = false; }
        items.push({ kind: isDir ? 'Ordner' : 'Datei', target: p });
      }
    } else {
      const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
      const textData = dt.getData('text/plain');
      const link = [uri, textData && textData.trim()].find((x) => x && refs.isUrl(x));
      if (link) {
        items.push({ kind: 'Link', target: link });
      } else if (textData) {
        const trimmed = textData.trim();
        const isLocalPath = /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\[^\\]+/.test(trimmed);
        if (isLocalPath) {
          let isDir = false;
          try { isDir = (await api.statPath(trimmed)).isDir; } catch { isDir = false; }
          items.push({ kind: isDir ? 'Ordner' : 'Datei', target: trimmed });
        } else {
          items.push({ text: textData });
        }
      }
    }
    if (!items.length) return;

    const nodes = [];
    for (const it of items) {
      // a target that cannot be a token (e.g. contains "]") is inserted as plain text
      const ok = it.kind && refs.refToken(it.kind, it.target);
      nodes.push(ok ? makeRef(it.kind, it.target) : document.createTextNode(it.text ?? it.target));
      nodes.push(document.createTextNode(' '));
    }
    insertNodes(nodes, point);
    updateResolvedPreview();
  }

  const composer = $('composer');
  ['dragenter', 'dragover'].forEach((t) => composer.addEventListener(t, (e) => { e.preventDefault(); composer.classList.add('drop'); }));
  ['dragleave', 'drop'].forEach((t) => composer.addEventListener(t, () => composer.classList.remove('drop')));
  composer.addEventListener('drop', (e) => handleDrop(e));

  const chatView = $('view-chat');
  if (chatView) {
    ['dragenter', 'dragover'].forEach((t) => chatView.addEventListener(t, (e) => { e.preventDefault(); composer.classList.add('drop'); }));
    chatView.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !chatView.contains(e.relatedTarget)) {
        composer.classList.remove('drop');
      }
    });
    chatView.addEventListener('drop', (e) => {
      if (e.target && e.target.closest('#composer')) return;
      composer.classList.remove('drop');
      handleDrop(e);
    });
  }

  // ---------- skill menu ----------
  // Only skills the connected workspace really has: the engine's list, else the app's own scan.
  // Nothing connected (or no known skill) -> no chips at all.
  const availableSkills = () => new Set(state.engineSkills.length ? state.engineSkills : state.workspaceSkills);

  function renderQuick() {
    const q = $('quick');
    q.innerHTML = '';
    const known = availableSkills();
    for (const s of SKILLS) {
      if (!known.has(s.skill)) continue;
      const b = document.createElement('button');
      const phrase = t('skill.' + s.key + '.phrase');
      b.textContent = t('skill.' + s.key + '.label');
      b.title = phrase;
      b.addEventListener('click', () => prefill(phrase));
      q.appendChild(b);
    }
    q.hidden = q.childElementCount === 0;
  }
  // ---------- explorer ----------
  async function renderDir(dir) {
    let listing;
    try {
      listing = await api.listDir(dir);
    } catch (err) {
      $('files').innerHTML = `<div class="empty">${esc(t('explorer.error', {err: err.message || err}))}</div>`;
      return;
    }
    state.dir = listing.dir;
    const crumbs = $('crumbs');
    crumbs.innerHTML = '';
    const parts = listing.dir.split(/[\\/]/).filter(Boolean);
    let acc = '';
    parts.forEach((part, i) => {
      acc = i === 0 ? part + '\\' : acc.replace(/\\?$/, '\\') + part;
      const target = acc;
      const b = document.createElement('button');
      b.textContent = part;
      b.addEventListener('click', () => renderDir(target));
      crumbs.appendChild(b);
      if (i < parts.length - 1) crumbs.appendChild(document.createTextNode('›'));
    });
    $('explorer-up').disabled = !listing.parent;
    $('explorer-up').onclick = () => listing.parent && renderDir(listing.parent);

    const grid = $('files');
    grid.innerHTML = '';
    if (!listing.entries.length) { grid.innerHTML = `<div class="empty">${t('explorer.empty')}</div>`; return; }
    for (const e of listing.entries) {
      const el = document.createElement('div');
      el.className = 'file';
      el.draggable = true;
      el.title = e.path;
      el.innerHTML = `<div class="f-ico">${e.isDir ? '📁' : FILE_ICONS[e.ext] || '📄'}</div><div class="f-name">${esc(e.name)}</div><div class="f-sub">${e.isDir ? `${e.size} ${t('explorer.items')}` : fmtSize(e.size)}</div>`;
      el.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('application/x-termi-entry', JSON.stringify({ path: e.path, isDir: e.isDir }));
        ev.dataTransfer.setData('text/plain', e.path);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      el.addEventListener('dblclick', () => (e.isDir ? renderDir(e.path) : api.openPath(e.path)));
      grid.appendChild(el);
    }
  }
  $('explorer-choose').addEventListener('click', async () => {
    const chosen = await api.chooseFolder();
    if (chosen) renderDir(chosen);
  });

  // ---------- adaptable layout: splitters + collapsible explorer (persisted) ----------
  const layout = $('layout');
  const LAYOUT_KEY = 'terminalBuddy.layout';
  const LAYOUT_DEFAULTS = { nav: 88, explorer: 420, explorerCollapsed: false };
  const LIMITS = { nav: [56, 200], explorer: [240, 800] };
  const loadLayout = () => {
    try { return { ...LAYOUT_DEFAULTS, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch { return { ...LAYOUT_DEFAULTS }; }
  };
  const ui = loadLayout();
  let explorerAutoCollapsed = false;
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Number(v) || lo));

  function applyLayout() {
    ui.nav = clamp(ui.nav, LIMITS.nav);
    // the chat column keeps at least ~360 px, whatever the explorer asks for
    const maxExplorer = Math.max(LIMITS.explorer[0], window.innerWidth - ui.nav - 360);
    ui.explorer = Math.min(clamp(ui.explorer, LIMITS.explorer), maxExplorer);
    layout.style.setProperty('--nav-w', `${ui.nav}px`);
    layout.style.setProperty('--explorer-w', `${ui.explorer}px`);
    layout.classList.toggle('nav-compact', ui.nav < 80);
    const collapsed = ui.explorerCollapsed || explorerAutoCollapsed;
    layout.classList.toggle('explorer-collapsed', collapsed);
    $('explorer-toggle').classList.toggle('active', !collapsed);
  }
  const saveLayout = () => localStorage.setItem(LAYOUT_KEY, JSON.stringify(ui));

  function setExplorerCollapsed(collapsed) {
    ui.explorerCollapsed = collapsed;
    explorerAutoCollapsed = false;
    applyLayout();
    saveLayout();
  }
  $('explorer-toggle').addEventListener('click', () => setExplorerCollapsed(!layout.classList.contains('explorer-collapsed')));
  $('explorer-hide').addEventListener('click', () => setExplorerCollapsed(true));

  document.querySelectorAll('.splitter').forEach((sp) => {
    const which = sp.dataset.split;
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      const startX = e.clientX;
      const start = ui[which];
      const move = (ev) => {
        const dx = ev.clientX - startX;
        ui[which] = which === 'nav' ? start + dx : start - dx; // the explorer grows to the left
        applyLayout();
      };
      const up = () => {
        sp.releasePointerCapture(e.pointerId);
        sp.classList.remove('dragging');
        document.body.classList.remove('resizing');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        saveLayout();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
    sp.addEventListener('dblclick', () => {
      ui[which] = LAYOUT_DEFAULTS[which];
      applyLayout();
      saveLayout();
    });
  });

  // Small windows hide the explorer automatically (not persisted) and bring it back when there is room.
  let wasNarrow = null;
  function onResize() {
    const narrow = window.innerWidth < 1000;
    if (narrow !== wasNarrow) explorerAutoCollapsed = narrow;
    wasNarrow = narrow;
    applyLayout();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // ---------- model picker ----------
  const modelSelect = $('model');
  let currentModel = '';
  function updateModelSelectState() {
    modelSelect.disabled = state.busy || !state.ready || modelSelect.options.length < 2;
  }
  async function refreshModels(activeModel) {
    if (activeModel !== undefined) currentModel = activeModel;
    let models = [];
    try { models = await api.listModels(); } catch { models = []; }
    modelSelect.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Standard';
    modelSelect.appendChild(def);
    const seen = new Set(['']);
    for (const m of models) {
      if (!m.value || seen.has(m.value)) continue;
      seen.add(m.value);
      const o = document.createElement('option');
      o.value = m.value;
      o.textContent = m.displayName || m.value;
      o.title = m.description || m.value;
      modelSelect.appendChild(o);
    }
    // The configured model may be a full id that is not in the list – keep it selectable.
    if (currentModel && !seen.has(currentModel)) {
      const o = document.createElement('option');
      o.value = currentModel;
      o.textContent = currentModel;
      modelSelect.appendChild(o);
    }
    modelSelect.value = currentModel;
    updateModelSelectState();
  }
  modelSelect.addEventListener('change', async () => {
    const chosen = modelSelect.value;
    modelSelect.disabled = true;
    termLine(`Modell wird gewechselt: ${chosen || 'Standard'} …`, 'info');
    try {
      const r = await api.setModel(chosen);
      currentModel = r.model;
      state.configuredModel = r.model;
      if (r.restarted) { state.ready = false; finishAssistant(); setStatus('', t('status.changing_model')); }
      else setStatus('ready', `${t('status.ready')} · ${modelSelect.selectedOptions[0]?.textContent || 'Standard'}`);
    } catch (err) {
      termLine(`Modellwechsel fehlgeschlagen: ${err.message || err}`, 'stderr');
      modelSelect.value = currentModel;
    }
    updateModelSelectState();
  });

  // ---------- persona picker ----------
  const personaSelect = $('persona');
  if (personaSelect) {
    personaSelect.addEventListener('change', async () => {
      const chosen = personaSelect.value;
      if (chosen === state.persona) return;
      state.persona = chosen;
      state.ready = false;
      finishAssistant();
      setStatus('', t('status.changing_persona'));
      termLine(`Ansprache gewechselt: ${state.persona === 'soft' ? t('persona.soft') : t('persona.standard')} – neue Sitzung`, 'info');
      await api.setPersona(state.persona);
    });
  }

  // ---------- language picker ----------
  const languageSelect = $('language');
  if (languageSelect) {
    languageSelect.addEventListener('change', async () => {
      const lang = languageSelect.value;
      if (lang === i18n.getLang()) return;
      i18n.setLang(lang);
      translateUI();
      if (api.setLanguage) await api.setLanguage(lang);
    });
  }

  // ---------- approvals picker ----------
  const approvalsSelect = $('approvals');
  function updateApprovalsUI(mode) {
    state.approvalMode = mode;
    if (approvalsSelect) {
      approvalsSelect.value = mode;
      approvalsSelect.classList.toggle('bypass', mode === 'bypass');
    }
    const isBypass = mode === 'bypass';
    document.body.classList.toggle('skip-perms', isBypass);
    const banner = $('skip-banner');
    if (banner) banner.hidden = !isBypass;
    const hint = document.querySelector('.hint');
    if (hint) {
      hint.dataset.i18n = isBypass ? 'hint.danger' : 'hint.main';
      hint.textContent = t(hint.dataset.i18n);
    }
  }

  if (approvalsSelect) {
    approvalsSelect.addEventListener('change', async () => {
      const mode = approvalsSelect.value;
      updateApprovalsUI(mode);
      const modeLabel = t(`approvals.${mode}`);
      termLine(`Freigabemodus gewechselt: ${modeLabel}`, 'info');
      if (api.setApprovalMode) await api.setApprovalMode(mode);
    });
  }

  // ---------- engine events ----------
  api.onEngineEvent((ev) => {
    switch (ev.kind) {
      case 'ready':
        if (state.ready) break;
        state.ready = true;
        setStatus(state.busy ? 'busy' : 'ready', state.busy ? t('status.busy', {agent: state.agentName || 'Assistant'}) : t('status.ready'));
        refreshModels(state.configuredModel || '');
        break;
      case 'init':
        state.ready = true;
        state.engineSkills = ev.skills || [];
        renderQuick();
        refreshModels(state.configuredModel || '');
        setStatus(state.busy ? 'busy' : 'ready', state.busy ? t('status.busy', {agent: state.agentName || 'Assistant'}) : `${t('status.ready')} · ${ev.model}`);
        break;
      case 'turn_start':
        setBusy(true);
        showWorking();
        break;
      case 'text_start':
        hideWorking();
        ensureAssistant();
        setBusy(true);
        break;
      case 'text_delta':
        ensureAssistant().raw += ev.text;
        renderCurrent();
        break;
      case 'text_done':
        finishAssistant();
        if (state.busy) showWorking();
        break;
      case 'tool_use':
        finishAssistant();
        addActivity(ev);
        setBusy(true);
        showWorking(WORKING_KEYS[ev.name] || 'tool');
        break;
      case 'tool_result':
        finishActivity(ev);
        if (state.busy && !state.current) showWorking();
        break;
      case 'permission_request':
        finishAssistant();
        hideWorking(); // now it waits for the user, the card says so
        addPermissionCard(ev);
        break;
      case 'permission_resolved':
        resolvePermissionCard(ev.requestId, ev.allowed);
        if (ev.allowed && state.busy) showWorking('tool');
        break;
      case 'result':
        hideWorking();
        finishAssistant();
        for (const [, el] of state.activities) el.classList.add('done');
        state.activities.clear();
        addTurnEnd(ev);
        setBusy(false);
        break;
      case 'terminal':
        termLine(ev.line, ev.level);
        break;
      case 'status':
        termLine(ev.text, 'info');
        break;
      case 'error':
        hideWorking();
        termLine(ev.text, 'stderr');
        addError(ev.text);
        setStatus('error', t('status.error'));
        setBusy(false);
        break;
    }
  });

  // Dev aids used by the screenshot mode (see main.ts).
  api.onShowView((view) => showView(view));
  api.onEchoUser((text) => { addUser(text); setBusy(true); showWorking(); });

  // ---------- boot ----------
  (async () => {
    const cfg = await api.getConfig();
    state.agentName = cfg.agentName || 'Assistant';
    
    // Update static DOM elements with the dynamic agent name
    document.title = state.agentName;
    const brandTitle = document.querySelector('.brand-title');
    if (brandTitle) brandTitle.textContent = state.agentName;

    state.configuredModel = cfg.model || '';
    const initialApprovalMode = cfg.approvalMode || (cfg.runtime && cfg.runtime.skipPermissions ? 'bypass' : 'safe');
    updateApprovalsUI(initialApprovalMode);

    if (cfg.language) i18n.setLang(cfg.language);
    if (languageSelect) languageSelect.value = i18n.getLang();
    translateUI();

    state.persona = cfg.persona || 'standard';
    if (personaSelect) personaSelect.value = state.persona;
    if (cfg.greetOnStart) setBusy(true); // the greeting turn is already on its way
    try { state.workspaceSkills = (await api.listSkills()) || []; } catch { state.workspaceSkills = []; }
    renderQuick();
    renderDir(cfg.workspaceRoot);
    input.focus();
  })();
})();
