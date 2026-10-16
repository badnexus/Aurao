/* Aurao – renderer. Plain JS on purpose (no build step for the UI).
   Talks to the engine through window.aurao (or fallback window.termi). */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.aurao || window.termi;
  const md = window.marked;
  const refs = window.refs;
  const i18n = window.i18n;
  const t = i18n.t;
  md.setOptions({ breaks: true, gfm: true });
  
  function updateBrandUI() {
    const name = state.agentName || 'Aurao';
    const lang = i18n.getLang ? i18n.getLang() : 'de';
    document.title = `${name} - ${lang === 'de' ? 'Dein Assistent für alles' : 'Your Assistant for Everything'}`;
    const brandTitle = document.querySelector('.brand-title');
    if (brandTitle) brandTitle.textContent = name;
    const auraLetter = document.querySelector('.aura-letter');
    if (auraLetter) auraLetter.textContent = name.charAt(0).toUpperCase();
    const auraBadge = document.querySelector('.aura-badge');
    if (auraBadge) auraBadge.textContent = name === 'Aurao' ? 'Aura' : name;
  }

  function translateUI() {
    const vars = { agent: state.agentName || 'Aurao' };
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (el.dataset.placeholder !== undefined) {
        el.dataset.placeholder = t(key, vars);
      } else if (el.id === 'send') {
        el.title = t('chat.sendTitle', vars) || t('chat.send', vars);
        el.textContent = state.busy ? (t('chat.stop') || 'stop') : (t('chat.send') || 'send');
      } else if (el.id === 'open-settings') {
        el.title = t(key, vars);
      } else {
        el.textContent = t(key, vars);
      }
    });
    const topbarNewChat = $('topbar-new-chat');
    if (topbarNewChat) {
      topbarNewChat.title = t('chat.newBtn', vars);
    }
    updateBrandUI();
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
    if (!view) return;
    state.view = view;
    document.querySelectorAll('.nav[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
    if (view === 'terminal') { state.unseenTerminal = 0; updateTerminalBadge(); }
    if (view === 'history') { loadHistory(); }
    if (view === 'chat') $('input').focus();
  }
  document.querySelectorAll('.nav[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

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

  const AURA_VISOR_SVG = `<svg class="aura-visor-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#67e8f9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="3"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/></svg>`;

  function addUser(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="user-msg-col"><div class="bubble">${refs.renderRefs(text)}</div><div class="msg-time">${now()}</div></div><div class="avatar user-avatar">👤</div>`;
    messages.appendChild(el);
    scrollDown(true);
  }

  function ensureAssistant() {
    if (state.current) return state.current;
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="avatar aura-orb" title="${esc(state.agentName || 'Aurao')}">${AURA_VISOR_SVG}</div><div class="bubble"><div class="meta"><b>${esc(state.agentName || 'Aurao')}</b><span>${now()}</span></div><div class="md cursor"></div></div>`;
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
    working.el.querySelector('.label').textContent = t('working.' + key, {agent: state.agentName || 'Aurao'});
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
    sendBtn.textContent = busy ? (t('chat.stop') || 'stop') : (t('chat.send') || 'send');
    sendBtn.title = busy ? (t('chat.stopTitle') || 'Stopp') : (t('chat.sendTitle') || 'Senden (Enter)');
    updateModelSelectState();
    setStatus(busy ? 'busy' : state.ready ? 'ready' : '', busy ? t('status.busy', {agent: state.agentName || 'Aurao'}) : state.ready ? t('status.ready') : t('status.starting'));
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
      else setStatus('ready', t('status.ready'));
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
    if (banner) {
      banner.hidden = !isBypass;
      // Name the launch flag only when the app was really started with it; otherwise bypass was picked here.
      banner.dataset.i18n = state.launchedWithSkip ? 'banner.danger' : 'banner.bypass';
      banner.textContent = t(banner.dataset.i18n);
    }
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

  // Dev aids used by the screenshot mode (see main.ts): switch view / echo an auto-sent message.
  if (api.onShowView) api.onShowView((view) => showView(view));
  if (api.onEchoUser) api.onEchoUser((text) => { addUser(text); setBusy(true); showWorking(); });

  // ---------- engine events ----------
  api.onEngineEvent((ev) => {
    switch (ev.kind) {
      case 'ready':
        if (state.ready) break;
        state.ready = true;
        setStatus(state.busy ? 'busy' : 'ready', state.busy ? t('status.busy', {agent: state.agentName || 'Aurao'}) : t('status.ready'));
        refreshModels(state.configuredModel || '');
        break;
      case 'init':
        state.ready = true;
        state.engineSkills = ev.skills || [];
        renderQuick();
        refreshModels(state.configuredModel || '');
        setStatus(state.busy ? 'busy' : 'ready', state.busy ? t('status.busy', {agent: state.agentName || 'Aurao'}) : t('status.ready'));
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
        if (/not found|nicht im PATH|keine aktive|start failed/i.test(ev.text)) {
          setTimeout(openSettings, 400);
        }
        break;
    }
  });

  // ---------- settings & diagnostics modal ----------
  const settingsDialog = $('settings-dialog');
  const openSettingsBtn = $('open-settings');
  const settingsCloseBtn = $('settings-close');
  const settingsCancelBtn = $('settings-cancel');
  const settingsForm = $('settings-form');
  const engineTypeSelect = $('cfg-engineType');
  const agentNameInput = $('cfg-agentName');
  const personaSelectCfg = $('cfg-persona');
  const languageSelectCfg = $('cfg-language');
  const approvalModeSelectCfg = $('cfg-approvalMode');
  const greetOnStartCheckbox = $('cfg-greetOnStart');
  const workspaceRootInput = $('cfg-workspaceRoot');
  const workspaceRepoInput = $('cfg-workspaceRepo');
  const workspaceGitUrlInput = $('cfg-workspaceGitUrl');
  const modelInput = $('cfg-model');
  const availableModelsInput = $('cfg-availableModels');
  const effortSelect = $('cfg-effort');
  const allowedToolsInput = $('cfg-allowedTools');
  const claudeExecutableInput = $('cfg-claudeExecutable');
  const sanitizeLogsCheckbox = $('cfg-sanitizeLogs');
  const chooseWorkspaceRootBtn = $('choose-workspaceRoot');
  const chooseWorkspaceRepoBtn = $('choose-workspaceRepo');
  const healthBox = $('health-box');
  const healthMsg = $('health-msg');
  const healthTip = $('health-tip');

  async function runHealthCheck(engineType) {
    if (!healthBox || !healthMsg) return;
    const engine = engineType || (engineTypeSelect ? engineTypeSelect.value : 'agy');
    healthBox.className = 'health-box';
    healthMsg.textContent = t('settings.checking');
    if (healthTip) {
      healthTip.hidden = true;
      healthTip.textContent = '';
    }

    try {
      const res = await api.checkHealth(engine);
      if (res && res.ok) {
        healthBox.className = 'health-box ok';
        healthMsg.textContent = res.message || 'Einsatzbereit';
        if (healthTip) healthTip.hidden = true;
      } else {
        healthBox.className = 'health-box error';
        healthMsg.textContent = (res && res.message) || 'Nicht bereit';
        if (healthTip && res && res.tip) {
          healthTip.textContent = res.tip;
          healthTip.hidden = false;
        }
      }
    } catch (err) {
      healthBox.className = 'health-box error';
      healthMsg.textContent = String(err);
    }
  }

  async function openSettings() {
    if (!settingsDialog) return;
    const cfg = await api.getConfig();
    if (engineTypeSelect) engineTypeSelect.value = cfg.engineType || 'agy';
    if (agentNameInput) agentNameInput.value = cfg.agentName || 'Aurao';
    if (personaSelectCfg) personaSelectCfg.value = cfg.persona || 'standard';
    if (languageSelectCfg) languageSelectCfg.value = cfg.language || i18n.getLang() || 'de';
    if (approvalModeSelectCfg) approvalModeSelectCfg.value = cfg.approvalMode || 'safe';
    if (greetOnStartCheckbox) greetOnStartCheckbox.checked = Boolean(cfg.greetOnStart);
    if (sanitizeLogsCheckbox) sanitizeLogsCheckbox.checked = cfg.sanitizeLogs !== false;
    if (workspaceRootInput) workspaceRootInput.value = cfg.workspaceRoot || '';
    if (workspaceRepoInput) workspaceRepoInput.value = cfg.workspaceRepo || '';
    if (workspaceGitUrlInput) workspaceGitUrlInput.value = cfg.workspaceGitUrl || '';
    if (modelInput) modelInput.value = cfg.model || '';
    if (availableModelsInput) availableModelsInput.value = Array.isArray(cfg.availableModels) ? cfg.availableModels.join(', ') : '';
    if (effortSelect) effortSelect.value = cfg.effort || '';
    if (allowedToolsInput) allowedToolsInput.value = Array.isArray(cfg.allowedTools) ? cfg.allowedTools.join(', ') : '';
    if (claudeExecutableInput) claudeExecutableInput.value = cfg.claudeExecutable || '';

    if (settingsDialog.showModal) settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');

    await runHealthCheck(engineTypeSelect ? engineTypeSelect.value : 'agy');
  }

  function closeSettings() {
    if (!settingsDialog) return;
    if (settingsDialog.close) settingsDialog.close();
    else settingsDialog.removeAttribute('open');
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', openSettings);
    openSettingsBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSettings();
      }
    });
  }
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
  if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettings);

  if (engineTypeSelect) {
    engineTypeSelect.addEventListener('change', () => {
      runHealthCheck(engineTypeSelect.value);
    });
  }

  if (chooseWorkspaceRootBtn && workspaceRootInput) {
    chooseWorkspaceRootBtn.addEventListener('click', async () => {
      const picked = await api.chooseDir(workspaceRootInput.value, t('explorer.choose'));
      if (picked) workspaceRootInput.value = picked;
    });
  }

  if (chooseWorkspaceRepoBtn && workspaceRepoInput) {
    chooseWorkspaceRepoBtn.addEventListener('click', async () => {
      const picked = await api.chooseDir(workspaceRepoInput.value, t('explorer.choose'));
      if (picked) workspaceRepoInput.value = picked;
    });
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawModels = availableModelsInput ? availableModelsInput.value.trim() : '';
      const modelsArr = rawModels ? rawModels.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const rawTools = allowedToolsInput ? allowedToolsInput.value.trim() : '';
      const toolsArr = rawTools ? rawTools.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

      const newCfg = {
        engineType: engineTypeSelect ? engineTypeSelect.value : 'agy',
        agentName: (agentNameInput ? agentNameInput.value.trim() : '') || 'Aurao',
        persona: personaSelectCfg ? personaSelectCfg.value : 'standard',
        language: languageSelectCfg ? languageSelectCfg.value : 'de',
        approvalMode: approvalModeSelectCfg ? approvalModeSelectCfg.value : 'safe',
        greetOnStart: greetOnStartCheckbox ? greetOnStartCheckbox.checked : false,
        sanitizeLogs: sanitizeLogsCheckbox ? sanitizeLogsCheckbox.checked : true,
        workspaceRoot: (workspaceRootInput ? workspaceRootInput.value.trim() : '') || undefined,
        workspaceRepo: (workspaceRepoInput ? workspaceRepoInput.value.trim() : '') || undefined,
        workspaceGitUrl: (workspaceGitUrlInput ? workspaceGitUrlInput.value.trim() : '') || undefined,
        model: (modelInput ? modelInput.value.trim() : '') || undefined,
        availableModels: modelsArr,
        effort: (effortSelect ? effortSelect.value : '') || undefined,
        allowedTools: toolsArr,
        claudeExecutable: (claudeExecutableInput ? claudeExecutableInput.value.trim() : '') || undefined,
      };

      closeSettings();
      termLine(t('settings.saved'), 'info');

      const updated = await api.saveAllConfig(newCfg);
      state.agentName = updated.agentName || 'Aurao';
      updateBrandUI();

      if (updated.language && updated.language !== i18n.getLang()) {
        i18n.setLang(updated.language);
        if (languageSelect) languageSelect.value = updated.language;
        translateUI();
      }
      if (personaSelect) personaSelect.value = updated.persona || 'standard';
      updateApprovalsUI(updated.approvalMode || 'safe');
      if (updated.workspaceRoot) renderDir(updated.workspaceRoot);
    });
  }

  // ---------- history & session resuming ----------
  async function loadHistory() {
    try {
      const [sessions, currentId] = await Promise.all([
        api.listSessions(),
        api.getCurrentSession(),
      ]);
      state.sessions = sessions || [];
      state.currentSessionId = currentId || null;
      renderHistory();
    } catch (e) {
      console.error('Failed to load history:', e);
      termLine(`Chat-Verlauf laden fehlgeschlagen: ${e.message || e}`, 'stderr');
    }
  }

  function renderHistory() {
    const listEl = $('history-list');
    if (!listEl) return;
    const filter = ($('history-search')?.value || '').trim().toLowerCase();
    const filtered = (state.sessions || []).filter((s) => {
      if (!filter) return true;
      return (
        (s.title && s.title.toLowerCase().includes(filter)) ||
        (s.preview && s.preview.toLowerCase().includes(filter)) ||
        (s.workspace && s.workspace.toLowerCase().includes(filter))
      );
    });

    const countEl = $('history-count');
    if (countEl) {
      countEl.textContent = `${filtered.length} / ${state.sessions.length}`;
    }

    if (!filtered.length) {
      listEl.innerHTML = `<div class="history-empty">${t('history.empty')}</div>`;
      return;
    }

    listEl.innerHTML = '';
    for (const s of filtered) {
      const isCurrent = s.isCurrent || s.id === state.currentSessionId;
      const card = document.createElement('div');
      card.className = `history-card${isCurrent ? ' current' : ''}`;

      let dateStr = '';
      if (s.lastModified) {
        try {
          const d = new Date(s.lastModified);
          dateStr = d.toLocaleDateString(i18n.getLang() === 'de' ? 'de-DE' : 'en-US', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch {
          dateStr = s.lastModified;
        }
      }

      const title = s.title || s.preview || 'Chat';
      const preview = s.preview || '';

      card.innerHTML = `
        <div class="history-card-main">
          <div class="history-card-title-row">
            <span class="history-card-title">${esc(title)}</span>
            ${isCurrent ? `<span class="history-badge active">${t('history.currentBadge')}</span>` : ''}
            ${s.matchesCwd ? `<span class="history-badge" title="${esc(s.workspace || '')}">📁 Workspace</span>` : ''}
          </div>
          ${preview && preview !== title ? `<div class="history-card-preview">${esc(preview)}</div>` : ''}
          <div class="history-card-meta">
            ${dateStr ? `<span>🕒 ${esc(dateStr)}</span>` : ''}
            ${s.stepCount ? `<span>💬 ${t('history.steps', { n: s.stepCount })}</span>` : ''}
            ${s.workspace ? `<span>${t('history.workspace', { path: esc(s.workspace) })}</span>` : ''}
          </div>
        </div>
        <div class="history-card-action">
          ${
            isCurrent
              ? `<button class="ghost disabled" disabled>${t('history.currentBadge')}</button>`
              : `<button class="primary history-resume-btn">${t('history.resumeBtn')}</button>`
          }
        </div>
      `;

      card.addEventListener('click', () => {
        if (!isCurrent) {
          switchSession(s.id, title);
        } else {
          showView('chat');
        }
      });

      listEl.appendChild(card);
    }
  }

  async function switchSession(sessionId, title) {
    setStatus('busy', t('status.starting'));
    messages.innerHTML = '';
    showView('chat');

    try {
      let history = [];
      if (sessionId && api.getSessionHistory) {
        try {
          history = (await api.getSessionHistory(sessionId)) || [];
        } catch (err) {
          console.warn('Failed to fetch session history:', err);
        }
      }

      await api.switchSession(sessionId);
      state.currentSessionId = sessionId;

      if (sessionId) {
        if (history && history.length) {
          renderRestoredHistory(history, title);
        } else {
          addSystemNotice(t('history.resumedNotice', { title: title || sessionId.slice(0, 8) }));
        }
      } else {
        addSystemNotice(t('history.newChatStarted'));
      }
    } catch (e) {
      console.error('Failed to switch session:', e);
      termLine(`Sitzungswechsel fehlgeschlagen: ${e.message || e}`, 'stderr');
    } finally {
      setStatus('ready', t('status.ready'));
    }
  }

  function renderRestoredHistory(history, title) {
    messages.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'turn-end';
    banner.style.cssText = 'margin:12px 0 16px 52px;opacity:0.85;';
    banner.textContent = `📜 ${t('history.restoredBanner', { n: history.length, title: title || '' })}`;
    messages.appendChild(banner);

    for (const msg of history) {
      if (msg.role === 'user') {
        renderPastUserMessage(msg.text, msg.timestamp);
      } else if (msg.role === 'assistant') {
        renderPastAssistantMessage(msg.text, msg.timestamp);
      }
    }
    scrollDown(true);
  }

  function renderPastUserMessage(text, timestamp) {
    let timeStr = '';
    if (timestamp) {
      try {
        timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        // ignore
      }
    }
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div class="user-msg-col"><div class="bubble">${refs.renderRefs(text)}</div><div class="msg-time">${esc(timeStr || now())}</div></div><div class="avatar user-avatar">👤</div>`;
    messages.appendChild(el);
  }

  function renderPastAssistantMessage(text, timestamp) {
    let timeStr = '';
    if (timestamp) {
      try {
        timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        // ignore
      }
    }
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `<div class="avatar aura-orb" title="${esc(state.agentName || 'Aurao')}">${AURA_VISOR_SVG}</div><div class="bubble"><div class="meta"><b>${esc(state.agentName || 'Aurao')}</b><span>${esc(timeStr || now())}</span></div><div class="md">${md.parse(text)}</div></div>`;
    messages.appendChild(el);
  }

  function addSystemNotice(text) {
    const el = document.createElement('div');
    el.className = 'msg system-notice';
    el.style.cssText = 'align-self:center;margin:16px auto;padding:8px 18px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);border-radius:20px;font-size:13px;color:#93c5fd;display:flex;align-items:center;gap:6px;';
    el.textContent = text;
    messages.appendChild(el);
    scrollDown(true);
  }

  const topbarNewChatBtn = $('topbar-new-chat');
  if (topbarNewChatBtn) topbarNewChatBtn.addEventListener('click', () => switchSession(null, ''));

  const historyNewChatBtn = $('history-new-chat-btn');
  if (historyNewChatBtn) historyNewChatBtn.addEventListener('click', () => switchSession(null, ''));

  const historyRefreshBtn = $('history-refresh-btn');
  if (historyRefreshBtn) historyRefreshBtn.addEventListener('click', () => loadHistory());

  const historySearchInput = $('history-search');
  if (historySearchInput) historySearchInput.addEventListener('input', () => renderHistory());

  // ---------- boot ----------
  (async () => {
    const cfg = await api.getConfig();
    state.agentName = cfg.agentName || 'Aurao';
    
    // Update static DOM elements with the dynamic agent name
    updateBrandUI();

    state.configuredModel = cfg.model || '';
    state.launchedWithSkip = Boolean(cfg.runtime && cfg.runtime.skipPermissions);
    const initialApprovalMode = cfg.approvalMode || (state.launchedWithSkip ? 'bypass' : 'safe');
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
