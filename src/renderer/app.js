'use strict';
/* File Explorer — renderer. Windows 11 Explorer behaviour on top of the macOS filesystem. */
(async function () {
  const { $, $$, el, P, fmtSize, fmtSizeKB, fmtDate, fmtDateLong, plural, kindOf, typeName, collator, showMenu, closeMenus, modal, alertBox, confirmBox, toast } = U;
  const api = window.api;
  const isMac = api.platform === 'darwin';
  const CMD = isMac ? '⌘' : 'Ctrl+';

  const info = await api.sysInfo();
  let settings = await api.getSettings();
  if (!Array.isArray(settings.columns)) settings.columns = ['name', 'date', 'type', 'size'];
  if (!settings.collapsed) settings.collapsed = {};

  const HOME = 'shell:home', THISPC = 'shell:thispc';
  const TRASH = info.paths.trash;
  const SPECIAL = {};
  for (const k of ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'applications']) if (info.paths[k]) SPECIAL[info.paths[k]] = k;
  SPECIAL[info.home] = 'home';
  const SPECIAL_LABEL = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', music: 'Music', videos: 'Videos', applications: 'Applications' };

  const VIEW_ICON_SIZE = { xl: 256, large: 96, medium: 48, small: 16, list: 16, details: 16, tiles: 48, content: 48 };
  const VIEWS = [
    ['xl', 'Extra large icons', Icons.vXl], ['large', 'Large icons', Icons.vLarge], ['medium', 'Medium icons', Icons.vMedium],
    ['small', 'Small icons', Icons.vSmall], ['list', 'List', Icons.vList], ['details', 'Details', Icons.vDetails],
    ['tiles', 'Tiles', Icons.vTiles], ['content', 'Content', Icons.vContent],
  ];
  const COLUMNS = {
    name: { label: 'Name', min: 120 },
    date: { label: 'Date modified', min: 80 },
    created: { label: 'Date created', min: 80 },
    accessed: { label: 'Date accessed', min: 80 },
    type: { label: 'Type', min: 60 },
    size: { label: 'Size', min: 50, right: true },
    folder: { label: 'Folder', min: 80 },
  };
  const SORT_KEYS = [['name', 'Name'], ['date', 'Date modified'], ['type', 'Type'], ['size', 'Size'], ['created', 'Date created']];
  const GROUP_KEYS = [['none', '(None)'], ['name', 'Name'], ['date', 'Date modified'], ['type', 'Type'], ['size', 'Size']];

  const state = {
    tabs: [],
    active: 0,
    all: [],
    items: [],
    byPath: new Map(),
    clipboard: null,
    undo: [],
    redo: [],
    token: 0,
    renaming: null,
    pendingReload: false,
    typeahead: { buf: '', t: 0 },
    tree: { expanded: new Set(['thispc']), children: new Map() },
    volumes: [],
    navHidden: false,
    error: null,
  };

  const content = $('#content');
  const tab = () => state.tabs[state.active];
  const curLoc = () => tab().loc;
  const isReal = (loc) => !P.isVirtual(loc);
  const saveSettings = (patch) => { Object.assign(settings, patch); return api.setSettings(patch); };

  /* ================================================================== */
  /* Locations                                                           */
  /* ================================================================== */
  function locName(loc) {
    if (loc === HOME) return 'Home';
    if (loc === THISPC) return 'This PC';
    if (loc === TRASH) return 'Recycle Bin';
    if (loc === '/') return 'Macintosh HD';
    if (SPECIAL_LABEL[SPECIAL[loc]]) return SPECIAL_LABEL[SPECIAL[loc]];
    return P.basename(loc);
  }
  function locIconHtml(loc, size = 16) {
    if (loc === HOME) return Icons.homeSvg(size);
    if (loc === THISPC) return Icons.pcSvg(size);
    if (loc === TRASH) return Icons.trashSvg(false, size);
    const v = state.volumes.find((x) => x.path === loc);
    if (v) return Icons.driveSvg(v.root ? 'hdd' : 'usb', size);
    return Icons.folderSvg(Icons.badges[SPECIAL[loc]] || '', size);
  }
  function resolveInput(text) {
    let t = text.trim();
    if (!t) return null;
    const low = t.toLowerCase();
    if (low === 'home' || low === 'quick access') return HOME;
    if (low === 'this pc' || low === 'computer') return THISPC;
    if (low === 'recycle bin' || low === 'trash') return TRASH;
    if (low === 'desktop' || low === 'downloads' || low === 'documents' || low === 'pictures' || low === 'music' || low === 'videos' || low === 'applications') return info.paths[low];
    if (t.startsWith('shell:')) return t;
    if (t === '~') return info.home;
    if (t.startsWith('~/')) t = info.home + t.slice(1);
    if (t.startsWith('file://')) t = decodeURIComponent(t.slice(7));
    if (!t.startsWith('/')) t = P.join(isReal(curLoc()) ? curLoc() : info.home, t);
    // normalize ./..
    const parts = [];
    for (const seg of t.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop(); else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  /* ================================================================== */
  /* Tabs                                                                */
  /* ================================================================== */
  let tabSeq = 0;
  function makeTab(loc) {
    return { id: ++tabSeq, loc, history: [loc], hi: 0, sel: new Set(), focus: null, anchor: null, search: null, scroll: 0 };
  }
  function addTab(loc = settings.startPage === 'thispc' ? THISPC : HOME, activate = true, index = null) {
    const t = makeTab(loc);
    if (index == null) state.tabs.push(t); else state.tabs.splice(index, 0, t);
    if (activate) activateTab(state.tabs.indexOf(t)); else renderTabs();
    return t;
  }
  function activateTab(i) {
    if (state.tabs[state.active]) state.tabs[state.active].scroll = content.scrollTop;
    state.active = Math.max(0, Math.min(i, state.tabs.length - 1));
    renderTabs();
    loadLocation({ restoreScroll: true });
  }
  function closeTab(i = state.active) {
    if (state.tabs.length === 1) { api.closeWindow(); return; }
    const t = state.tabs[i];
    if (t.search) api.searchCancel(t.search.id);
    state.tabs.splice(i, 1);
    if (state.active >= state.tabs.length) state.active = state.tabs.length - 1;
    else if (i < state.active) state.active--;
    activateTab(state.active);
  }
  function tabTitle(t) {
    if (t.search) return `${t.search.query} - Search Results in ${locName(t.search.root)}`;
    return locName(t.loc);
  }
  function renderTabs() {
    const wrap = $('#tabs');
    wrap.innerHTML = '';
    state.tabs.forEach((t, i) => {
      const te = el('div', {
        class: 'tab' + (i === state.active ? ' active' : ''), role: 'tab', title: t.search ? tabTitle(t) : (isReal(t.loc) ? t.loc : tabTitle(t)),
        onmousedown: (e) => { if (e.button === 0 && !e.target.closest('.tab-close')) activateTab(i); },
        onauxclick: (e) => { if (e.button === 1) closeTab(i); },
        oncontextmenu: (e) => { e.preventDefault(); tabMenu(e, i); },
      },
      el('span', { class: 'tab-icon', html: t.search ? Icons.search : locIconHtml(t.loc, 16) }),
      el('span', { class: 'tab-title', text: tabTitle(t) }),
      el('button', { class: 'tab-close icon-btn small', title: 'Close tab (⌘W)', html: Icons.close, onclick: (e) => { e.stopPropagation(); closeTab(i); } }));
      // Drag & drop: hover to activate, drop to move into the tab's folder
      let hoverT = null;
      te.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (i !== state.active && !hoverT) hoverT = setTimeout(() => activateTab(i), 700);
        e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        te.classList.add('drop');
      });
      te.addEventListener('dragleave', () => { clearTimeout(hoverT); hoverT = null; te.classList.remove('drop'); });
      te.addEventListener('drop', (e) => { clearTimeout(hoverT); hoverT = null; te.classList.remove('drop'); if (isReal(t.loc)) handleDrop(e, t.loc); });
      wrap.append(te);
    });
    document.title = `${tabTitle(tab())} - File Explorer`;
  }
  function tabMenu(e, i) {
    const t = state.tabs[i];
    showMenu([
      { label: 'New tab', icon: Icons.plus, shortcut: `${CMD}T`, action: () => addTab(undefined, true, i + 1) },
      { label: 'Duplicate tab', icon: Icons.copy, action: () => addTab(t.loc, true, i + 1) },
      { label: 'Move tab to new window', icon: Icons.window, action: () => { api.newWindow(t.loc); closeTab(i); } },
      { separator: true },
      { label: 'Close tab', icon: Icons.close, shortcut: `${CMD}W`, action: () => closeTab(i) },
      { label: 'Close other tabs', disabled: state.tabs.length < 2, action: () => { state.tabs = [t]; state.active = 0; activateTab(0); } },
      { label: 'Close tabs to the right', disabled: i === state.tabs.length - 1, action: () => { state.tabs.splice(i + 1); if (state.active > i) state.active = i; activateTab(state.active); } },
    ], { x: e.clientX, y: e.clientY });
  }

  /* ================================================================== */
  /* Navigation                                                          */
  /* ================================================================== */
  async function navigate(loc, { push = true } = {}) {
    if (!loc) return;
    const t = tab();
    if (isReal(loc)) {
      const isDir = await api.isDir(loc);
      if (!isDir) {
        if (await api.exists(loc)) { openPaths([loc]); return; }
        await alertBox('File Explorer', `File Explorer can't find '${loc}'. Check the spelling and try again.`, 'error');
        return;
      }
    }
    if (t.search) { api.searchCancel(t.search.id); t.search = null; $('#search-input').value = ''; }
    const prev = t.loc;
    if (push && loc !== t.loc) {
      t.history = t.history.slice(0, t.hi + 1);
      t.history.push(loc);
      t.hi = t.history.length - 1;
    }
    t.loc = loc;
    t.sel = new Set();
    t.focus = null; t.anchor = null; t.scroll = 0;
    // When going up, select the folder we came from (Windows behaviour)
    if (isReal(prev) && isReal(loc) && P.dirname(prev) === loc) { t.sel.add(prev); t.focus = prev; t.anchor = prev; }
    renderTabs();
    await loadLocation({ revealFocus: true });
  }
  function goBack() {
    const t = tab();
    if (t.search) { clearSearch(); return; }
    if (t.hi > 0) { t.hi--; navigate(t.history[t.hi], { push: false }); }
  }
  function goForward() {
    const t = tab();
    if (t.hi < t.history.length - 1) { t.hi++; navigate(t.history[t.hi], { push: false }); }
  }
  function goUp() {
    const loc = curLoc();
    if (tab().search) { clearSearch(); return; }
    if (loc === HOME) return;
    if (loc === THISPC) { navigate(HOME); return; }
    if (loc === '/' || state.volumes.some((v) => v.path === loc)) { navigate(THISPC); return; }
    navigate(P.dirname(loc));
  }

  async function loadLocation({ preserve = false, restoreScroll = false, revealFocus = false } = {}) {
    const t = tab();
    const token = ++state.token;
    state.error = null;
    updateChrome();
    let entries = [];
    if (t.search) {
      entries = t.search.results;
    } else if (t.loc === HOME) {
      entries = await buildHome();
    } else if (t.loc === THISPC) {
      entries = await buildThisPC();
    } else {
      try {
        entries = await api.readDir(t.loc);
      } catch (err) {
        state.error = err.message || String(err);
      }
    }
    if (token !== state.token) return;
    state.all = entries;
    const scroll = preserve ? content.scrollTop : (restoreScroll ? t.scroll : 0);
    applyView();
    content.scrollTop = scroll;
    if (revealFocus && t.focus) revealItem(t.focus);
    watchTabs();
  }
  function reload() {
    if (state.renaming) { state.pendingReload = true; return; }
    loadLocation({ preserve: true });
  }
  function watchTabs() {
    const dirs = new Set();
    for (const t of state.tabs) if (isReal(t.loc)) dirs.add(t.loc);
    api.watch([...dirs]);
  }
  api.onChanged((dir) => {
    if (dir === curLoc() && !tab().search) reload();
    if (state.tree.children.has(dir)) refreshTreeNode(dir);
  });

  /* ---------- Virtual folders ---------- */
  async function statSafe(p) { try { return await api.stat(p); } catch { return null; } }
  async function buildHome() {
    const pins = (await Promise.all(settings.pins.map(statSafe))).filter(Boolean).map((e) => ({ ...e, group: 'quick', pinned: true }));
    let recent = [];
    if (settings.showRecent !== false) {
      recent = (await Promise.all(settings.recent.slice(0, 25).map(statSafe))).filter(Boolean).map((e) => ({ ...e, group: 'recent' }));
    }
    return [...pins, ...recent];
  }
  async function buildThisPC() {
    state.volumes = await api.volumes();
    const folders = (await Promise.all(['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'applications'].map((k) => info.paths[k] && statSafe(info.paths[k]))))
      .filter(Boolean).map((e) => ({ ...e, group: 'folders' }));
    const drives = state.volumes.map((v) => ({
      name: v.name, path: v.path, isDir: true, size: 0, mtime: 0, ext: '', group: 'drives', drive: v,
    }));
    return [...folders, ...drives];
  }

  /* ================================================================== */
  /* View config, sorting, grouping                                      */
  /* ================================================================== */
  function viewKey() { const t = tab(); return t.search ? '__search__' : t.loc; }
  function viewCfg() {
    const k = viewKey();
    const base = k === '__search__' ? { ...settings.defaultView, view: 'details' } : settings.defaultView;
    return { ...base, ...(settings.folderViews[k] || {}) };
  }
  function setViewCfg(patch) {
    if (!tab().search && !isReal(curLoc())) {
      if (patch.view || patch.sortKey) { /* virtual folders have fixed layout */ }
      return;
    }
    const k = viewKey();
    settings.folderViews[k] = { ...(settings.folderViews[k] || {}), ...patch };
    saveSettings({ folderViews: settings.folderViews });
    applyView();
  }
  function compare(a, b, key, dir) {
    if (a.isDir !== b.isDir && !(a.isPackage || b.isPackage)) return a.isDir ? -1 : 1;
    let r = 0;
    switch (key) {
      case 'date': r = a.mtime - b.mtime; break;
      case 'created': r = a.btime - b.btime; break;
      case 'accessed': r = a.atime - b.atime; break;
      case 'size': r = a.size - b.size; break;
      case 'type': r = collator.compare(typeName(a), typeName(b)); break;
      case 'folder': r = collator.compare(P.dirname(a.path), P.dirname(b.path)); break;
      default: r = 0;
    }
    if (r === 0) r = collator.compare(a.name, b.name);
    return r * dir;
  }
  function groupOf(e, key) {
    switch (key) {
      case 'name': {
        const c = (e.name[0] || '').toUpperCase();
        if (/[0-9]/.test(c)) return ['0 - 9', 0];
        if (c >= 'A' && c <= 'H') return ['A - H', 1];
        if (c >= 'I' && c <= 'P') return ['I - P', 2];
        if (c >= 'Q' && c <= 'Z') return ['Q - Z', 3];
        return ['Other', 4];
      }
      case 'type': return [typeName(e), typeName(e)];
      case 'size': {
        if (e.isDir) return ['Unspecified', 9];
        const s = e.size, K = 1024, M = K * K, G = M * K;
        if (s === 0) return ['Empty (0 KB)', 0];
        if (s < 16 * K) return ['Tiny (0 - 16 KB)', 1];
        if (s < M) return ['Small (16 KB - 1 MB)', 2];
        if (s < 128 * M) return ['Medium (1 - 128 MB)', 3];
        if (s < G) return ['Large (128 MB - 1 GB)', 4];
        if (s < 4 * G) return ['Huge (1 - 4 GB)', 5];
        return ['Gigantic (> 4 GB)', 6];
      }
      case 'date': {
        const now = new Date(); const d = new Date(e.mtime);
        const day = 864e5;
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startWeek = startToday - now.getDay() * day;
        const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        const startYear = new Date(now.getFullYear(), 0, 1).getTime();
        const t = d.getTime();
        if (t >= startToday + day) return ['In the future', -1];
        if (t >= startToday) return ['Today', 0];
        if (t >= startToday - day) return ['Yesterday', 1];
        if (t >= startWeek) return ['Earlier this week', 2];
        if (t >= startWeek - 7 * day) return ['Last week', 3];
        if (t >= startMonth) return ['Earlier this month', 4];
        if (t >= startLastMonth) return ['Last month', 5];
        if (t >= startYear) return ['Earlier this year', 6];
        return ['A long time ago', 7];
      }
      default: return ['', 0];
    }
  }
  function visibleEntries() {
    let list = state.all;
    if (!settings.showHidden) list = list.filter((e) => !e.hidden || e.drive);
    return list;
  }
  function applyView() {
    const t = tab();
    const cfg = viewCfg();
    let list = visibleEntries().slice();
    if (isReal(t.loc) || t.search) list.sort((a, b) => compare(a, b, cfg.sortKey, cfg.sortDir));
    state.items = list;
    state.byPath = new Map(list.map((e) => [e.path, e]));
    // prune selection
    for (const p of [...t.sel]) if (!state.byPath.has(p)) t.sel.delete(p);
    if (t.focus && !state.byPath.has(t.focus)) t.focus = null;
    renderContent();
    renderCommandBar();
    renderStatus();
    renderPane();
    renderNavSelection();
  }

  /* ================================================================== */
  /* Content rendering                                                   */
  /* ================================================================== */
  function displayName(e) {
    if (e.drive) return e.name;
    if (e.path === '/') return 'Macintosh HD';
    if (SPECIAL_LABEL[SPECIAL[e.path]] && e.isDir) return SPECIAL_LABEL[SPECIAL[e.path]];
    if (settings.hideExtensions && !e.isDir && e.ext && !e.name.startsWith('.')) return P.stem(e.name);
    return e.name;
  }
  function folderIcon(e, size) {
    return Icons.folderSvg(Icons.badges[SPECIAL[e.path]] || '', size);
  }
  function iconEl(e, size) {
    const span = el('span', { class: 'icon', style: { width: size + 'px', height: size + 'px' } });
    if (e.drive) { span.innerHTML = Icons.driveSvg(e.drive.root ? 'hdd' : 'usb', size); return span; }
    if (e.isDir && !e.isPackage) { span.innerHTML = folderIcon(e, size); }
    else {
      span.innerHTML = e.isPackage && e.ext === 'app' ? Icons.appSvg(size) : Icons.genericFileSvg(size >= 32 ? e.ext : '', size);
      span.dataset.lazy = '1';
    }
    if (e.isSymlink) span.append(el('span', { class: 'link-badge', html: Icons.link }));
    return span;
  }
  /* Lazy icon / thumbnail loader with a small concurrency limit */
  const iconQueue = [];
  let iconActive = 0;
  const thumbCache = new Map();
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      iconQueue.push(en.target);
    }
    pumpIcons();
  }, { root: content, rootMargin: '200px' });
  function pumpIcons() {
    while (iconActive < 8 && iconQueue.length) {
      const span = iconQueue.shift();
      if (!span.isConnected) continue;
      iconActive++;
      loadIcon(span).finally(() => { iconActive--; pumpIcons(); });
    }
  }
  async function loadIcon(span) {
    const p = span.closest('[data-path]')?.dataset.path;
    if (!p) return;
    const e = state.byPath.get(p) || { path: p, ext: P.ext(p) };
    const size = parseInt(span.style.width, 10) || 16;
    let url = null;
    const kind = kindOf(e.ext);
    const wantThumb = size >= 48 && (isMac || kind === 'image');
    if (wantThumb) {
      const key = p + '|' + size + '|' + e.mtime;
      if (thumbCache.has(key)) url = thumbCache.get(key);
      else { url = await api.thumb(p, Math.min(512, size * 2)); thumbCache.set(key, url); }
      if (url) span.classList.add(kind === 'image' || kind === 'video' ? 'thumb' : 'qlthumb');
    }
    if (!url) {
      const iconSize = size <= 16 ? 'small' : (size <= 32 || isMac ? 'normal' : 'large');
      const key = e.isPackage || !e.ext || ['icns', 'app', 'dmg', 'exe', 'lnk', 'alias'].includes(e.ext) ? p : 'ext:' + e.ext;
      url = await api.icon(p, iconSize, key);
    }
    if (url && span.isConnected) {
      const img = new Image();
      img.src = url;
      img.draggable = false;
      img.decoding = 'async';
      img.onload = () => { const badge = span.querySelector('.link-badge'); span.innerHTML = ''; span.append(img); if (badge) span.append(badge); };
    }
  }
  function observeIcons(root = content) {
    for (const s of $$('.icon[data-lazy]', root)) io.observe(s);
  }

  function gridCols() {
    const cols = settings.columns.filter((c) => c !== 'folder' || tab().search);
    if (tab().search && !cols.includes('folder')) cols.splice(1, 0, 'folder');
    return cols;
  }
  function applyColTemplate() {
    const cols = gridCols();
    const w = settings.colWidths;
    content.style.setProperty('--cols', cols.map((c) => (w[c] || 150) + 'px').join(' ') + ' 1fr');
    content.style.setProperty('--cols-width', cols.reduce((s, c) => s + (w[c] || 150), 0) + 'px');
  }

  function itemEl(e, mode) {
    const t = tab();
    const size = mode === 'home-tile' ? 48 : (VIEW_ICON_SIZE[mode] || 16);
    const cls = ['item'];
    if (t.sel.has(e.path)) cls.push('selected');
    if (t.focus === e.path) cls.push('focused');
    if (e.hidden) cls.push('hidden-item');
    if (state.clipboard && state.clipboard.mode === 'cut' && state.clipboard.paths.includes(e.path)) cls.push('cut');
    const it = el('div', { class: cls.join(' '), 'data-path': e.path, draggable: 'true', title: '' });
    if (settings.itemCheckboxes) it.append(el('span', { class: 'cb', html: Icons.check }));
    const name = el('span', { class: 'name', text: displayName(e) });
    if (mode === 'details') {
      for (const c of gridCols()) {
        if (c === 'name') { it.append(el('span', { class: 'cell c-name' }, iconEl(e, size), name)); continue; }
        let v = '';
        if (c === 'date') v = fmtDate(e.mtime);
        else if (c === 'created') v = fmtDate(e.btime);
        else if (c === 'accessed') v = fmtDate(e.atime);
        else if (c === 'type') v = typeName(e);
        else if (c === 'size') v = e.isDir ? '' : fmtSizeKB(e.size);
        else if (c === 'folder') v = P.dirname(e.path);
        it.append(el('span', { class: 'cell c-' + c + (COLUMNS[c].right ? ' right' : ''), text: v, title: c === 'folder' ? v : null }));
      }
    } else if (mode === 'tiles') {
      it.append(iconEl(e, size), el('span', { class: 'tile-text' }, name, el('span', { class: 'sub', text: typeName(e) }), el('span', { class: 'sub', text: e.isDir ? '' : fmtSize(e.size) })));
    } else if (mode === 'content') {
      it.append(iconEl(e, size),
        el('span', { class: 'ct-main' }, name, el('span', { class: 'sub', text: e.isDir ? '' : typeName(e) })),
        el('span', { class: 'ct-meta' }, el('span', { class: 'sub', text: (e.isDir ? 'Date modified: ' : 'Date modified: ') + fmtDate(e.mtime) }), el('span', { class: 'sub', text: e.isDir ? '' : 'Size: ' + fmtSize(e.size) })));
    } else if (mode === 'home-tile') {
      const sub = e.drive ? '' : (SPECIAL[e.path] && P.dirname(e.path) === info.home ? 'Stored locally' : P.dirname(e.path).replace(info.home, '~'));
      it.append(iconEl(e, 48), el('span', { class: 'tile-text' }, name, el('span', { class: 'sub' }, e.pinned ? el('span', { class: 'pin-glyph', html: Icons.pin }) : '', sub)));
    } else {
      it.append(iconEl(e, size), name);
    }
    if (e.isDir && !e.isPackage) it.dataset.dir = '1';
    return it;
  }

  function renderContent() {
    const t = tab();
    const cfg = viewCfg();
    content.innerHTML = '';
    content.scrollLeft = 0;
    iconQueue.length = 0;
    document.body.classList.toggle('checkboxes', !!settings.itemCheckboxes);
    if (state.error) {
      const denied = /EPERM|EACCES|not permitted/i.test(state.error);
      content.className = 'view-message';
      content.append(el('div', { class: 'empty-msg' },
        el('div', { class: 'big', html: Icons.warning }),
        el('div', { text: denied ? 'You don\'t currently have permission to access this folder.' : `File Explorer can't open this location.` }),
        el('div', { class: 'sub', text: denied && isMac ? 'macOS protects this folder. Grant File Explorer "Full Disk Access" in System Settings › Privacy & Security, then refresh.' : state.error }),
        denied && isMac ? el('button', { class: 'btn primary', text: 'Open Privacy Settings', onclick: () => api.privacy() }) : null));
      return;
    }
    if (!t.search && t.loc === HOME) return renderHome();
    if (!t.search && t.loc === THISPC) return renderThisPC();
    const mode = cfg.view;
    content.className = 'view-' + mode + (settings.compact ? ' compact' : '');
    if (!state.items.length) {
      content.append(el('div', { class: 'empty-msg' + (mode === 'details' ? ' with-header' : '') }, t.search
        ? (t.search.done ? 'No items match your search.' : 'Searching…')
        : 'This folder is empty.'));
      if (mode === 'details') { applyColTemplate(); content.prepend(detailsHeader()); }
      return;
    }
    const frag = document.createDocumentFragment();
    if (mode === 'details') { applyColTemplate(); frag.append(detailsHeader()); }
    const groupKey = mode === 'list' ? 'none' : cfg.groupBy;
    const body = el('div', { class: 'items' });
    if (groupKey && groupKey !== 'none') {
      const groups = new Map();
      for (const e of state.items) {
        const [label, order] = groupOf(e, groupKey);
        if (!groups.has(label)) groups.set(label, { label, order, list: [] });
        groups.get(label).list.push(e);
      }
      const arr = [...groups.values()].sort((a, b) => (typeof a.order === 'string' ? collator.compare(a.order, b.order) : a.order - b.order) * (groupKey === 'date' ? 1 : cfg.sortDir));
      const ordered = [];
      for (const g of arr) {
        const collapsed = settings.collapsed['g:' + g.label];
        const gh = el('div', { class: 'group-header' + (collapsed ? ' collapsed' : '') },
          el('span', { class: 'chev', html: Icons.chevronDown }), el('span', { text: `${g.label} (${g.list.length})` }), el('span', { class: 'line' }));
        gh.addEventListener('click', () => { settings.collapsed['g:' + g.label] = !collapsed; saveSettings({ collapsed: settings.collapsed }); renderContent(); });
        body.append(gh);
        if (!collapsed) for (const e of g.list) { body.append(itemEl(e, mode)); ordered.push(e); }
      }
      state.items = ordered;
    } else {
      for (const e of state.items) body.append(itemEl(e, mode));
    }
    frag.append(body);
    content.append(frag);
    if (mode === 'list') layoutList();
    observeIcons();
  }
  function layoutList() {
    const body = $('.items', content);
    if (!body) return;
    const rowH = settings.compact ? 22 : 26;
    const rows = Math.max(1, Math.floor((content.clientHeight - 16) / rowH));
    body.style.gridTemplateRows = `repeat(${rows}, ${rowH}px)`;
  }
  new ResizeObserver(() => { if (content.classList.contains('view-list')) layoutList(); }).observe(content);

  function detailsHeader() {
    const cfg = viewCfg();
    const h = el('div', { class: 'details-header' });
    for (const c of gridCols()) {
      const sortable = !!c;
      const cell = el('div', { class: 'hcell' + (COLUMNS[c].right ? ' right' : '') + (cfg.sortKey === c ? ' sorted' : ''), 'data-col': c },
        el('span', { class: 'hlabel', text: COLUMNS[c].label }),
        cfg.sortKey === c ? el('span', { class: 'sort-arrow', html: cfg.sortDir > 0 ? Icons.chevronUp : Icons.chevronDown }) : null,
        el('span', { class: 'resizer' }));
      if (sortable) cell.addEventListener('click', (e) => {
        if (e.target.classList.contains('resizer')) return;
        setViewCfg({ sortKey: c, sortDir: cfg.sortKey === c ? -cfg.sortDir : 1 });
      });
      const rz = $('.resizer', cell);
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startW = settings.colWidths[c] || 150;
        const mv = (ev) => { settings.colWidths[c] = Math.max(COLUMNS[c].min, startW + ev.clientX - startX); applyColTemplate(); };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); saveSettings({ colWidths: settings.colWidths }); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      });
      rz.addEventListener('dblclick', (e) => { e.stopPropagation(); autoSizeColumn(c); });
      h.append(cell);
    }
    h.append(el('div', { class: 'hcell filler' }));
    h.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showMenu([
        ...Object.keys(COLUMNS).filter((c) => c !== 'folder').map((c) => ({
          label: COLUMNS[c].label, checked: settings.columns.includes(c), disabled: c === 'name',
          action: () => {
            const cols = settings.columns.includes(c) ? settings.columns.filter((x) => x !== c) : [...settings.columns, c];
            saveSettings({ columns: Object.keys(COLUMNS).filter((k) => cols.includes(k)) });
            renderContent();
          },
        })),
        { separator: true },
        { label: 'Size all columns to fit', action: () => { gridCols().forEach(autoSizeColumn); } },
      ], { x: e.clientX, y: e.clientY });
    });
    return h;
  }
  function autoSizeColumn(c) {
    const cells = $$(`.cell.c-${c}`, content);
    const meas = el('span', { style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap', font: getComputedStyle(content).font } });
    document.body.append(meas);
    let max = 0;
    for (const cell of cells.slice(0, 2000)) { meas.textContent = cell.textContent; max = Math.max(max, meas.offsetWidth); }
    meas.remove();
    settings.colWidths[c] = Math.max(COLUMNS[c].min, max + (c === 'name' ? 52 : 24));
    applyColTemplate();
    saveSettings({ colWidths: settings.colWidths });
  }

  function section(key, title, children, extraClass = '') {
    const collapsed = settings.collapsed[key];
    const s = el('section', { class: 'home-section' + (collapsed ? ' collapsed' : '') });
    const h = el('div', { class: 'home-section-head' }, el('span', { class: 'chev', html: Icons.chevronDown }), el('span', { text: title }));
    h.addEventListener('click', () => { settings.collapsed[key] = !collapsed; saveSettings({ collapsed: settings.collapsed }); renderContent(); });
    s.append(h);
    if (!collapsed) s.append(el('div', { class: 'home-section-body ' + extraClass }, children));
    return s;
  }
  function renderHome() {
    content.className = 'view-home';
    const quick = state.items.filter((e) => e.group === 'quick');
    const recent = state.items.filter((e) => e.group === 'recent');
    content.append(section('home:quick', 'Quick access', quick.length ? quick.map((e) => itemEl(e, 'home-tile')) : el('div', { class: 'hint', text: 'Pin folders to Quick access and they\'ll show up here.' }), 'tiles-grid'));
    if (settings.showRecent !== false) {
      const head = el('div', { class: 'recent-head' }, el('span', { text: 'Name' }), el('span', { text: 'Date modified' }), el('span', { text: 'File location' }));
      const rows = recent.map((e) => {
        const it = el('div', { class: 'item recent-row' + (tab().sel.has(e.path) ? ' selected' : '') + (tab().focus === e.path ? ' focused' : ''), 'data-path': e.path, draggable: 'true' },
          el('span', { class: 'cell c-name' }, iconEl(e, 16), el('span', { class: 'name', text: displayName(e) })),
          el('span', { class: 'cell', text: fmtDate(e.mtime) }),
          el('span', { class: 'cell', text: P.dirname(e.path).replace(info.home, '~'), title: P.dirname(e.path) }));
        if (e.isDir) it.dataset.dir = '1';
        return it;
      });
      content.append(section('home:recent', 'Recent', rows.length ? [head, ...rows] : el('div', { class: 'hint', text: 'After you\'ve opened some files, we\'ll show the most recent ones here.' }), 'recent-list'));
    }
    state.items = [...quick, ...recent];
    observeIcons();
  }
  function renderThisPC() {
    content.className = 'view-home';
    const folders = state.items.filter((e) => e.group === 'folders');
    const drives = state.items.filter((e) => e.group === 'drives');
    content.append(section('pc:folders', 'Folders', folders.map((e) => itemEl(e, 'home-tile')), 'tiles-grid'));
    const driveEls = drives.map((e) => {
      const v = e.drive;
      const used = v.total ? (v.total - v.free) / v.total : 0;
      const it = el('div', { class: 'item drive-tile' + (tab().sel.has(e.path) ? ' selected' : ''), 'data-path': e.path, 'data-dir': '1', draggable: 'false' },
        iconEl(e, 48),
        el('span', { class: 'tile-text' },
          el('span', { class: 'name', text: v.root ? `${v.name} (/)` : v.name }),
          el('span', { class: 'bar' + (used > 0.9 ? ' full' : '') }, el('span', { style: { width: (used * 100).toFixed(1) + '%' } })),
          el('span', { class: 'sub', text: v.total ? `${fmtSize(v.free)} free of ${fmtSize(v.total)}` : '' })));
      return it;
    });
    content.append(section('pc:drives', 'Devices and drives', driveEls, 'tiles-grid drives'));
    state.items = [...folders, ...drives];
    observeIcons();
  }

  function itemNode(p) { return content.querySelector(`.item[data-path="${CSS.escape(p)}"]`); }
  function revealItem(p) {
    const n = itemNode(p);
    if (!n) return;
    const cr = content.getBoundingClientRect(), r = n.getBoundingClientRect();
    const headerH = $('.details-header', content)?.offsetHeight || 0;
    if (r.top < cr.top + headerH) content.scrollTop -= cr.top + headerH - r.top + 4;
    else if (r.bottom > cr.bottom) content.scrollTop += r.bottom - cr.bottom + 4;
    if (r.left < cr.left) content.scrollLeft -= cr.left - r.left + 4;
    else if (r.right > cr.right) content.scrollLeft += r.right - cr.right + 4;
  }

  /* ================================================================== */
  /* Selection                                                           */
  /* ================================================================== */
  function selected() { const t = tab(); return state.items.filter((e) => t.sel.has(e.path)).map((e) => e.path); }
  function selectedEntries() { const t = tab(); return state.items.filter((e) => t.sel.has(e.path)); }
  function syncSelection() {
    const t = tab();
    for (const n of $$('.item', content)) {
      n.classList.toggle('selected', t.sel.has(n.dataset.path));
      n.classList.toggle('focused', t.focus === n.dataset.path);
    }
    renderStatus();
    renderCommandBar();
    schedulePane();
  }
  function selectOnly(p) { const t = tab(); t.sel = new Set(p ? [p] : []); t.focus = p; t.anchor = p; syncSelection(); }
  function selectRange(toPath, additive) {
    const t = tab();
    const paths = state.items.map((e) => e.path);
    const a = paths.indexOf(t.anchor ?? toPath), b = paths.indexOf(toPath);
    if (a < 0 || b < 0) return selectOnly(toPath);
    if (!additive) t.sel = new Set();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) t.sel.add(paths[i]);
    t.focus = toPath;
    syncSelection();
  }
  function selectAll() { const t = tab(); t.sel = new Set(state.items.map((e) => e.path)); syncSelection(); }
  function selectNone() { const t = tab(); t.sel = new Set(); syncSelection(); }
  function invertSelection() { const t = tab(); t.sel = new Set(state.items.map((e) => e.path).filter((p) => !t.sel.has(p))); syncSelection(); }

  /* ---------- Mouse ---------- */
  let pendingClick = null;
  content.addEventListener('mousedown', (e) => {
    if (state.renaming && e.target.closest('.rename-box')) return;
    content.focus({ preventScroll: true });
    const it = e.target.closest('.item');
    const t = tab();
    if (e.button === 2) {
      if (it && !t.sel.has(it.dataset.path)) selectOnly(it.dataset.path);
      return;
    }
    if (e.button !== 0) return;
    if (it) {
      const p = it.dataset.path;
      const toggle = e.metaKey || e.ctrlKey || e.target.closest('.cb');
      if (e.shiftKey) { selectRange(p, toggle); }
      else if (toggle) {
        if (t.sel.has(p)) t.sel.delete(p); else t.sel.add(p);
        t.focus = p; t.anchor = p; syncSelection();
      } else if (t.sel.has(p)) {
        pendingClick = p; // decide on mouseup (allows dragging multi-selection)
        t.focus = p; t.anchor = p; syncSelection();
      } else selectOnly(p);
    } else if (!e.target.closest('.details-header,.group-header,.home-section-head,.empty-msg button')) {
      startMarquee(e);
    }
  });
  content.addEventListener('mouseup', (e) => {
    const it = e.target.closest('.item');
    if (pendingClick && it && it.dataset.path === pendingClick && !(e.metaKey || e.ctrlKey || e.shiftKey)) {
      selectOnly(pendingClick);
    }
    pendingClick = null;
  });
  content.addEventListener('dblclick', (e) => {
    const it = e.target.closest('.item');
    if (!it || e.target.closest('.rename-box')) return;
    openPaths([it.dataset.path], { newTab: e.metaKey || e.ctrlKey });
  });
  content.addEventListener('auxclick', (e) => {
    const it = e.target.closest('.item');
    if (e.button === 1 && it && it.dataset.dir) openInNewTab(it.dataset.path, false);
  });
  content.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const it = e.target.closest('.item');
    if (it) itemMenu(e.clientX, e.clientY);
    else { if (!(e.metaKey || e.ctrlKey)) selectNone(); backgroundMenu(e.clientX, e.clientY); }
  });
  content.addEventListener('wheel', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !isReal(curLoc())) return;
    e.preventDefault();
    const order = ['details', 'list', 'small', 'medium', 'large', 'xl'];
    const i = order.indexOf(viewCfg().view);
    const n = Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + (e.deltaY < 0 ? 1 : -1)));
    if (order[n] !== viewCfg().view) setViewCfg({ view: order[n] });
  }, { passive: false });

  /* ---------- Marquee (rubber band) selection ---------- */
  function startMarquee(e) {
    const t = tab();
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    const base = additive ? new Set(t.sel) : new Set();
    if (!additive) { t.sel = new Set(); syncSelection(); }
    const box = $('#marquee');
    const cr = content.getBoundingClientRect();
    const sx = e.clientX - cr.left + content.scrollLeft, sy = e.clientY - cr.top + content.scrollTop;
    const rects = $$('.item', content).map((n) => {
      const r = n.getBoundingClientRect();
      return { p: n.dataset.path, x1: r.left - cr.left + content.scrollLeft, y1: r.top - cr.top + content.scrollTop, x2: r.right - cr.left + content.scrollLeft, y2: r.bottom - cr.top + content.scrollTop };
    });
    let started = false, lastEv = e, raf = null;
    const update = () => {
      const ev = lastEv;
      const cx = Math.max(0, Math.min(ev.clientX - cr.left, content.clientWidth)) + content.scrollLeft;
      const cy = Math.max(0, Math.min(ev.clientY - cr.top, content.clientHeight)) + content.scrollTop;
      if (!started && Math.abs(cx - sx) + Math.abs(cy - sy) < 4) return;
      started = true;
      const x1 = Math.min(sx, cx), y1 = Math.min(sy, cy), x2 = Math.max(sx, cx), y2 = Math.max(sy, cy);
      Object.assign(box.style, { display: 'block', left: x1 - content.scrollLeft + content.offsetLeft + 'px', top: y1 - content.scrollTop + content.offsetTop + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      const sel = new Set(base);
      for (const r of rects) {
        if (r.x1 < x2 && r.x2 > x1 && r.y1 < y2 && r.y2 > y1) { if (base.has(r.p) && (lastEv.metaKey || lastEv.ctrlKey)) sel.delete(r.p); else sel.add(r.p); }
      }
      t.sel = sel;
      for (const n of $$('.item', content)) n.classList.toggle('selected', sel.has(n.dataset.path));
      // auto-scroll
      if (ev.clientY > cr.bottom - 10) content.scrollTop += 12; else if (ev.clientY < cr.top + 10) content.scrollTop -= 12;
    };
    const mv = (ev) => { lastEv = ev; cancelAnimationFrame(raf); raf = requestAnimationFrame(update); };
    const scrollTimer = setInterval(() => { if (started) update(); }, 50);
    const up = () => {
      removeEventListener('mousemove', mv); removeEventListener('mouseup', up); clearInterval(scrollTimer);
      box.style.display = 'none';
      if (started) { const last = [...t.sel].pop(); t.focus = last || null; t.anchor = t.focus; }
      syncSelection();
    };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  }

  /* ---------- Keyboard navigation ---------- */
  function moveFocus(dir, e) {
    const t = tab();
    const nodes = $$('.item', content);
    if (!nodes.length) return;
    let idx = nodes.findIndex((n) => n.dataset.path === t.focus);
    let target = null;
    if (idx < 0) target = nodes[0];
    else if (dir === 'home') target = nodes[0];
    else if (dir === 'end') target = nodes[nodes.length - 1];
    else {
      const cur = nodes[idx].getBoundingClientRect();
      const cx = cur.left + cur.width / 2, cy = cur.top + cur.height / 2;
      if (dir === 'pagedown' || dir === 'pageup') {
        const delta = content.clientHeight * (dir === 'pagedown' ? 1 : -1);
        let best = null, bd = Infinity;
        for (const n of nodes) { const r = n.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - (cy + delta)) * 10 + Math.abs(r.left + r.width / 2 - cx); if (d < bd) { bd = d; best = n; } }
        target = best;
      } else {
        // geometric nearest neighbour in direction
        let best = null, bd = Infinity;
        const isList = content.classList.contains('view-list');
        for (const n of nodes) {
          if (n === nodes[idx]) continue;
          const r = n.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const dx = x - cx, dy = y - cy;
          let ok = false, d = 0;
          if (dir === 'down') { ok = dy > 2; d = dy * 1 + Math.abs(dx) * 4; }
          if (dir === 'up') { ok = dy < -2; d = -dy + Math.abs(dx) * 4; }
          if (dir === 'right') { ok = dx > 2; d = dx + Math.abs(dy) * 4; }
          if (dir === 'left') { ok = dx < -2; d = -dx + Math.abs(dy) * 4; }
          if (isList && (dir === 'down' || dir === 'up')) { // list view flows by column
            const i2 = nodes.indexOf(n); ok = dir === 'down' ? i2 === idx + 1 : i2 === idx - 1; d = 0;
          }
          if (ok && d < bd) { bd = d; best = n; }
        }
        // in grid views, wrap left/right to previous/next item
        if (!best && (dir === 'right' || dir === 'left')) best = nodes[idx + (dir === 'right' ? 1 : -1)];
        target = best;
      }
    }
    if (!target) return;
    const p = target.dataset.path;
    if (e.shiftKey) selectRange(p, e.metaKey || e.ctrlKey);
    else if (e.metaKey || e.ctrlKey) { t.focus = p; syncSelection(); }
    else selectOnly(p);
    revealItem(p);
  }
  function typeAhead(ch) {
    const ta = state.typeahead;
    const now = Date.now();
    ta.buf = now - ta.t > 900 ? ch : ta.buf + ch;
    ta.t = now;
    const q = ta.buf.toLowerCase();
    const t = tab();
    const start = Math.max(0, state.items.findIndex((e) => e.path === t.focus));
    const n = state.items.length;
    const offset = ta.buf.length === 1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const e = state.items[(start + offset + i) % n];
      if (displayName(e).toLowerCase().startsWith(q)) { selectOnly(e.path); revealItem(e.path); return; }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-back') || document.querySelector('.peek')) return;
    const inInput = e.target.matches('input, textarea, select');
    const mod = e.metaKey || e.ctrlKey;
    // Global (work even in inputs)
    if (e.key === 'F4' || (e.altKey && e.code === 'KeyD')) { e.preventDefault(); editAddress(); return; }
    if (e.key === 'F3' || (mod && e.code === 'KeyE')) { e.preventDefault(); $('#search-input').focus(); $('#search-input').select(); return; }
    if (e.key === 'F5') { e.preventDefault(); reload(); refreshTree(); return; }
    if (e.altKey && e.key === 'ArrowLeft' && !inInput) { e.preventDefault(); goBack(); return; }
    if (e.altKey && e.key === 'ArrowRight' && !inInput) { e.preventDefault(); goForward(); return; }
    if (e.altKey && e.key === 'ArrowUp' && !inInput) { e.preventDefault(); goUp(); return; }
    if (mod && /^Digit[1-9]$/.test(e.code) && !e.shiftKey && !e.altKey) { e.preventDefault(); const n = +e.code.slice(5); activateTab(n === 9 ? state.tabs.length - 1 : n - 1); return; }
    if (e.key === 'F1') { e.preventDefault(); showShortcuts(); return; }
    if (e.key === 'F11') { return; }
    if (inInput) return;
    if (e.target.closest('#navpane')) return; // nav pane handles its own keys
    const t = tab();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveFocus(mod && e.altKey ? 'end' : 'down', e); return;
      case 'ArrowUp':
        e.preventDefault();
        if (mod && !e.shiftKey) { goUp(); return; }
        moveFocus('up', e); return;
      case 'ArrowLeft': e.preventDefault(); moveFocus('left', e); return;
      case 'ArrowRight': e.preventDefault(); moveFocus('right', e); return;
      case 'Home': e.preventDefault(); moveFocus('home', e); return;
      case 'End': e.preventDefault(); moveFocus('end', e); return;
      case 'PageDown': e.preventDefault(); moveFocus('pagedown', e); return;
      case 'PageUp': e.preventDefault(); moveFocus('pageup', e); return;
      case 'Enter':
        e.preventDefault();
        if (e.altKey) { showProperties(selected()); return; }
        if (selected().length) openPaths(selected(), { newTab: mod });
        return;
      case 'F2': e.preventDefault(); renameSelected(); return;
      case 'Delete': e.preventDefault(); deleteSelected(e.shiftKey); return;
      case 'Backspace':
        e.preventDefault();
        if (mod) deleteSelected(e.altKey); else goBack();
        return;
      case 'Escape':
        if (t.search) { clearSearch(); return; }
        if (state.clipboard && state.clipboard.mode === 'cut') { state.clipboard = null; renderContent(); return; }
        selectNone(); return;
      case ' ':
        e.preventDefault();
        if (mod) { if (t.focus) { if (t.sel.has(t.focus)) t.sel.delete(t.focus); else t.sel.add(t.focus); syncSelection(); } return; }
        if (selected().length) peek(selected()[0]);
        return;
      case 'ContextMenu': {
        e.preventDefault();
        const n = t.focus && itemNode(t.focus);
        const r = n ? n.getBoundingClientRect() : content.getBoundingClientRect();
        if (n) itemMenu(r.left + 20, r.bottom); else backgroundMenu(r.left + 20, r.top + 20);
        return;
      }
      default: break;
    }
    if (e.shiftKey && e.key === 'F10') { e.preventDefault(); const n = t.focus && itemNode(t.focus); const r = (n || content).getBoundingClientRect(); n ? itemMenu(r.left + 20, r.bottom) : backgroundMenu(r.left + 20, r.top + 20); return; }
    if (!mod && !e.altKey && e.key.length === 1 && e.key !== ' ') { typeAhead(e.key); }
  });

  /* Clipboard events (from the Edit menu roles / ⌘C ⌘X ⌘V) */
  document.addEventListener('copy', (e) => { if (e.target.matches && e.target.matches('input, textarea')) return; e.preventDefault(); copyCut('copy'); });
  document.addEventListener('cut', (e) => { if (e.target.matches && e.target.matches('input, textarea')) return; e.preventDefault(); copyCut('cut'); });
  document.addEventListener('paste', (e) => { if (e.target.matches && e.target.matches('input, textarea')) return; e.preventDefault(); paste(); });

  /* ================================================================== */
  /* Drag & drop                                                         */
  /* ================================================================== */
  content.addEventListener('dragstart', (e) => {
    const it = e.target.closest('.item');
    if (!it || state.renaming) { e.preventDefault(); return; }
    const t = tab();
    if (!t.sel.has(it.dataset.path)) selectOnly(it.dataset.path);
    const paths = selected().filter((p) => !state.byPath.get(p)?.drive);
    e.preventDefault();
    if (paths.length) api.startDrag(paths);
    pendingClick = null;
  });
  let dropHover = null, dropHoverTimer = null;
  function dropTargetFor(e) {
    const it = e.target.closest && e.target.closest('.item[data-dir]');
    if (it) return { node: it, dir: it.dataset.path };
    if (isReal(curLoc()) && !tab().search) return { node: null, dir: curLoc() };
    return null;
  }
  content.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    const tgt = dropTargetFor(e);
    if (!tgt) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? 'copy' : (e.metaKey ? 'move' : 'move');
    if (dropHover !== tgt.node) {
      dropHover && dropHover.classList.remove('drop');
      dropHover = tgt.node;
      dropHover && dropHover.classList.add('drop');
      clearTimeout(dropHoverTimer);
      // spring-loaded folders
      if (tgt.node) dropHoverTimer = setTimeout(() => navigate(tgt.dir), 1500);
    }
    content.classList.toggle('drop-bg', !tgt.node);
  });
  content.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && content.contains(e.relatedTarget)) return;
    dropHover && dropHover.classList.remove('drop'); dropHover = null; clearTimeout(dropHoverTimer);
    content.classList.remove('drop-bg');
  });
  content.addEventListener('drop', (e) => {
    clearTimeout(dropHoverTimer);
    content.classList.remove('drop-bg');
    dropHover && dropHover.classList.remove('drop'); dropHover = null;
    const tgt = dropTargetFor(e);
    if (tgt) handleDrop(e, tgt.dir);
  });
  async function handleDrop(e, destDir) {
    e.preventDefault();
    const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    if (paths.includes(destDir)) return;
    if (!e.altKey && paths.every((p) => P.dirname(p) === destDir)) return;
    const mode = e.altKey ? 'copy' : (e.metaKey ? 'move' : 'auto');
    await transfer(paths, destDir, mode);
  }
  // Prevent the window from navigating when dropping files elsewhere
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  /* ================================================================== */
  /* File operations                                                     */
  /* ================================================================== */
  function pushUndo(u) { state.undo.push(u); if (state.undo.length > 100) state.undo.shift(); state.redo = []; renderCommandBar(); }
  async function afterChange(selectPaths, { rename = false } = {}) {
    const t = tab();
    if (selectPaths && selectPaths.length) {
      t.sel = new Set(selectPaths); t.focus = selectPaths[selectPaths.length - 1]; t.anchor = t.focus;
    }
    await loadLocation({ preserve: true });
    if (selectPaths && selectPaths.length) revealItem(t.focus);
    if (rename && selectPaths && selectPaths[0]) startRename(selectPaths[0]);
  }

  async function openPaths(paths, { newTab = false } = {}) {
    for (const p of paths) {
      const e = state.byPath.get(p);
      const isDir = e ? (e.isDir && !e.isPackage) : await api.isDir(p);
      if (isDir) {
        if (newTab || (settings.openFoldersInNewTab && paths.length === 1)) openInNewTab(p, paths.length === 1);
        else if (paths.length === 1) navigate(p);
        else openInNewTab(p, false);
      } else {
        try { await api.open(p); } catch (err) { alertBox(P.basename(p), err.message, 'error'); }
      }
    }
  }
  function openInNewTab(p, activate = true) { addTab(p, activate, state.active + 1); if (!activate) toast(`Opened "${locName(p)}" in a new tab`); }

  async function copyCut(mode) {
    const paths = selected().filter((p) => !state.byPath.get(p)?.drive);
    if (!paths.length) return;
    state.clipboard = { mode, paths };
    await api.clipWriteFiles(paths);
    for (const n of $$('.item', content)) n.classList.toggle('cut', mode === 'cut' && paths.includes(n.dataset.path));
    renderCommandBar();
  }
  async function clipboardSource() {
    let src = state.clipboard;
    const sys = await api.clipReadFiles();
    if (sys.length && !(src && sys.length === src.paths.length && sys.every((p) => src.paths.includes(p)))) src = { mode: 'copy', paths: sys };
    return src;
  }
  async function paste(destDir = null) {
    const dest = destDir || (isReal(curLoc()) && !tab().search ? curLoc() : null);
    if (!dest) return;
    const src = await clipboardSource();
    if (!src || !src.paths.length) { api.beep(); return; }
    const ok = await transfer(src.paths, dest, src.mode === 'cut' ? 'move' : 'copy');
    if (ok && src.mode === 'cut') { state.clipboard = null; renderCommandBar(); }
  }
  async function pasteShortcut() {
    const dest = isReal(curLoc()) ? curLoc() : null;
    const src = await clipboardSource();
    if (!dest || !src) return;
    const made = await api.symlink(src.paths, dest);
    pushUndo({ type: 'copy', label: 'Paste shortcut', pairs: made.map((to) => ({ to })) });
    afterChange(made);
  }
  async function conflictDialog(conflicts, dest, mode, total) {
    const verb = mode === 'copy' ? 'Copying' : 'Moving';
    const body = el('div', { class: 'conflict' },
      el('div', { class: 'conflict-sub', text: `${verb} ${plural(total, 'item')} to ${locName(dest)}` }),
      el('div', { class: 'conflict-title', text: conflicts.length === 1 ? `The destination already has a file named "${P.basename(conflicts[0].target)}"` : `The destination has ${conflicts.length} files with the same names` }));
    return modal({
      title: 'Replace or Skip Files', width: 460, body, buttons: [{ label: 'Cancel', value: null }],
      onOpen: (c, done) => {
        const opt = (icon, label, value) => el('button', { class: 'choice', onclick: () => done(value) }, el('span', { class: 'choice-icon', html: icon }), el('span', { text: label }));
        c.append(opt(Icons.check, 'Replace the file' + (conflicts.length > 1 ? 's' : '') + ' in the destination', 'replace'),
          opt(Icons.forward, 'Skip ' + (conflicts.length > 1 ? 'these files' : 'this file'), 'skip'),
          opt(Icons.copy, 'Keep both (rename the new ' + (conflicts.length > 1 ? 'files' : 'file') + ')', 'keepboth'));
        setTimeout(() => $('.choice', c).focus(), 0);
      },
    });
  }
  async function transfer(sources, destDir, mode) {
    sources = sources.filter((s) => s !== destDir);
    if (!sources.length) return false;
    let policy = 'keepboth';
    const conflicts = await api.conflicts(sources, destDir);
    if (conflicts.length) {
      policy = await conflictDialog(conflicts, destDir, mode === 'auto' ? 'move' : mode, sources.length);
      if (!policy) return false;
    }
    const r = await api.transfer({ sources, destDir, mode, policy });
    if (r.errors.length) alertBox('File Explorer', r.errors.join('\n'), 'error');
    if (r.results.length) {
      pushUndo({ type: r.mode === 'move' ? 'move' : 'copy', label: r.mode === 'move' ? 'Move' : 'Copy', pairs: r.results });
    }
    if (destDir === curLoc()) await afterChange(r.results.map((x) => x.to));
    else reload();
    return true;
  }

  async function deleteSelected(permanent = false) {
    const paths = selected().filter((p) => !state.byPath.get(p)?.drive);
    if (!paths.length || !isReal(curLoc()) && !tab().search && curLoc() !== HOME) return;
    if (curLoc() === HOME) {
      // removing from Home = unpin / remove from recent
      for (const p of paths) { settings.pins = settings.pins.filter((x) => x !== p); settings.recent = settings.recent.filter((x) => x !== p); }
      saveSettings({ pins: settings.pins, recent: settings.recent });
      renderNav(); reload();
      return;
    }
    const inTrash = isReal(curLoc()) && (curLoc() === TRASH || curLoc().startsWith(TRASH + '/'));
    if (permanent || inTrash) {
      const msg = paths.length === 1 ? `Are you sure you want to permanently delete "${P.basename(paths[0])}"?` : `Are you sure you want to permanently delete these ${paths.length} items?`;
      const ok = await confirmBox(paths.length === 1 ? 'Delete File' : 'Delete Multiple Items', msg);
      if (!ok) return;
    }
    const idx = state.items.findIndex((e) => e.path === paths[0]);
    const r = permanent || inTrash ? await api.del(paths) : await api.trash(paths);
    if (r.errors.length) alertBox('File Explorer', r.errors.join('\n'), 'error');
    if (r.restore && r.restore.length) pushUndo({ type: 'trash', label: 'Delete', pairs: r.restore });
    // select the item now at the same index (Windows behaviour)
    const remaining = state.items.filter((e) => !paths.includes(e.path));
    const next = remaining[Math.min(idx, remaining.length - 1)];
    await afterChange(next ? [next.path] : []);
  }

  async function undo() {
    const u = state.undo.pop();
    if (!u) { api.beep(); return; }
    try {
      if (u.type === 'rename') await api.rename(u.to, P.basename(u.from));
      else if (u.type === 'move' || u.type === 'trash') {
        const r = await api.movePairs(u.pairs.map((p) => (u.type === 'trash' ? { from: p.from, to: p.to } : { from: p.to, to: p.from })));
        if (r.errors.length) throw new Error(r.errors.join('\n'));
      } else if (u.type === 'copy' || u.type === 'new') {
        await api.trash(u.pairs.map((p) => p.to));
      }
      state.redo.push(u);
      toast(`Undo ${u.label || u.type}`);
    } catch (err) { alertBox('Undo', err.message, 'error'); }
    const sel = u.type === 'rename' ? [u.from] : u.type === 'move' || u.type === 'trash' ? u.pairs.map((p) => (u.type === 'trash' ? p.to : p.from)) : [];
    afterChange(sel.filter((p) => P.dirname(p) === curLoc()));
  }
  async function redo() {
    const u = state.redo.pop();
    if (!u) { api.beep(); return; }
    try {
      if (u.type === 'rename') await api.rename(u.from, P.basename(u.to));
      else if (u.type === 'move') await api.movePairs(u.pairs.map((p) => ({ from: p.from, to: p.to })));
      else if (u.type === 'trash') await api.trash(u.pairs.map((p) => p.to));
      else { api.beep(); return; }
      state.undo.push(u);
      toast(`Redo ${u.label || u.type}`);
    } catch (err) { alertBox('Redo', err.message, 'error'); }
    reload();
  }

  async function newFolder() {
    if (!isReal(curLoc()) || tab().search) return;
    try {
      const p = await api.mkdir(curLoc(), 'New folder');
      pushUndo({ type: 'new', label: 'New folder', pairs: [{ to: p }] });
      await afterChange([p], { rename: true });
    } catch (err) { alertBox('File Explorer', err.message, 'error'); }
  }
  async function newFile(name, contentStr = '') {
    if (!isReal(curLoc()) || tab().search) return;
    try {
      let data = contentStr;
      if (name.endsWith('.zip')) data = '\x50\x4b\x05\x06' + '\x00'.repeat(18);
      const p = await api.newFile(curLoc(), name, data);
      pushUndo({ type: 'new', label: 'New item', pairs: [{ to: p }] });
      await afterChange([p], { rename: true });
    } catch (err) { alertBox('File Explorer', err.message, 'error'); }
  }
  async function newShortcut() {
    const target = await api.pickFolder('Select the item the shortcut should point to');
    if (!target) return;
    const made = await api.symlink([target], curLoc());
    pushUndo({ type: 'new', label: 'New shortcut', pairs: made.map((to) => ({ to })) });
    afterChange(made, { rename: true });
  }

  /* ---------- Inline rename ---------- */
  function renameSelected() {
    const s = selected();
    if (curLoc() === HOME || curLoc() === THISPC) { if (s[0] && !state.byPath.get(s[0])?.drive) startRename(s[0]); return; }
    if (s.length) startRename(tab().focus && s.includes(tab().focus) ? tab().focus : s[0]);
  }
  function startRename(p) {
    const e = state.byPath.get(p);
    const node = itemNode(p);
    if (!e || !node || e.drive || p === '/') return;
    revealItem(p);
    const nameEl = $('.name', node);
    const shown = displayName(e);
    const hiddenExt = shown !== e.name ? e.name.slice(shown.length) : '';
    const multiline = !content.classList.contains('view-details') && !content.classList.contains('view-list') && !node.classList.contains('recent-row');
    const input = el(multiline ? 'textarea' : 'input', { class: 'rename-box', spellcheck: 'false', rows: multiline ? 1 : null });
    input.value = shown;
    nameEl.style.visibility = 'hidden';
    nameEl.parentElement.insertBefore(input, nameEl.nextSibling);
    node.draggable = false;
    state.renaming = p;
    const fit = () => { if (multiline) { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; } };
    fit();
    input.focus();
    const dot = e.isDir ? -1 : shown.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : shown.length);
    let finished = false;
    const finish = async (commit, moveNext = 0) => {
      if (finished) return;
      finished = true;
      const val = input.value.trim().replace(/\n/g, '');
      input.remove();
      nameEl.style.visibility = '';
      node.draggable = true;
      state.renaming = null;
      content.focus({ preventScroll: true });
      let newPath = p;
      if (commit && val && val !== shown) {
        const newName = val + hiddenExt;
        if (!e.isDir && !hiddenExt && P.ext(e.name) !== P.ext(newName) && P.ext(e.name)) {
          const ok = await confirmBox('Rename', 'If you change a file name extension, the file might become unusable.\n\nAre you sure you want to change it?');
          if (!ok) { finishReload(); return; }
        }
        try {
          newPath = await api.rename(p, newName);
          pushUndo({ type: 'rename', label: 'Rename', from: p, to: newPath });
          if (settings.pins.includes(p)) { settings.pins = settings.pins.map((x) => (x === p ? newPath : x)); saveSettings({ pins: settings.pins }); renderNav(); }
        } catch (err) {
          await alertBox('Rename', err.message, 'error');
        }
      }
      const t = tab();
      t.sel = new Set([newPath]); t.focus = newPath; t.anchor = newPath;
      await loadLocation({ preserve: true });
      state.pendingReload = false;
      if (moveNext) {
        const i = state.items.findIndex((x) => x.path === newPath);
        const nx = state.items[i + moveNext];
        if (nx) { selectOnly(nx.path); startRename(nx.path); }
      }
    };
    const finishReload = () => { const t = tab(); t.sel = new Set([p]); loadLocation({ preserve: true }); };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, ev.shiftKey ? -1 : 1); }
      else if (/[/:]/.test(ev.key)) {
        ev.preventDefault();
        showTip(input, 'A file name can\'t contain any of the following characters:\n/ :');
      }
    });
    input.addEventListener('input', fit);
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  }
  function showTip(anchor, text) {
    const tip = $('#tooltip');
    const r = anchor.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = r.left + 'px'; tip.style.top = r.bottom + 4 + 'px';
    tip.classList.add('show');
    clearTimeout(showTip.t);
    showTip.t = setTimeout(() => tip.classList.remove('show'), 3000);
  }

  /* ---------- Other actions ---------- */
  async function compressSelected() {
    const paths = selected();
    if (!paths.length) return;
    try {
      toast('Compressing…');
      const z = await api.compress(paths);
      pushUndo({ type: 'new', label: 'Compress', pairs: [{ to: z }] });
      await afterChange([z], { rename: true });
    } catch (err) { alertBox('Compressed (zipped) Folders', err.message, 'error'); }
  }
  async function extractSelected(choose = false) {
    const paths = selected().filter((p) => U.KIND.archive.includes(P.ext(p)) && P.ext(p) !== 'dmg' && P.ext(p) !== 'pkg');
    if (!paths.length) return;
    let dest = null;
    if (choose) { dest = await api.pickFolder('Select a Destination and Extract Files'); if (!dest) return; }
    const made = [];
    for (const p of paths) {
      try { toast(`Extracting ${P.basename(p)}…`); made.push(await api.extract(p, dest)); } catch (err) { alertBox('Extract', err.message, 'error'); }
    }
    if (made.length) pushUndo({ type: 'new', label: 'Extract', pairs: made.map((to) => ({ to })) });
    if (made.length === 1 && P.dirname(made[0]) === curLoc()) afterChange(made); else reload();
  }
  function copyPath() {
    const paths = selected();
    const list = paths.length ? paths : (isReal(curLoc()) ? [curLoc()] : []);
    if (!list.length) return;
    api.clipWriteText(list.map((p) => (p.includes(' ') ? `"${p}"` : p)).join('\n'));
    toast(list.length === 1 ? 'Path copied' : `${list.length} paths copied`);
  }
  function togglePin(paths) {
    const allPinned = paths.every((p) => settings.pins.includes(p));
    if (allPinned) settings.pins = settings.pins.filter((p) => !paths.includes(p));
    else for (const p of paths) if (!settings.pins.includes(p)) settings.pins.push(p);
    saveSettings({ pins: settings.pins });
    renderNav();
    if (curLoc() === HOME) reload();
    toast(allPinned ? 'Unpinned from Quick access' : 'Pinned to Quick access');
  }
  function setPane(p) {
    saveSettings({ pane: settings.pane === p ? 'none' : p });
    layoutPanes();
    renderPane();
    renderCommandBar();
  }
  function toggleSetting(key) {
    saveSettings({ [key]: !settings[key] });
    if (key === 'compact') document.body.classList.toggle('compact', settings.compact);
    applyView();
    renderNav();
  }

  /* ================================================================== */
  /* Context menus                                                       */
  /* ================================================================== */
  function viewSubmenu() {
    const cfg = viewCfg();
    return [
      ...VIEWS.map(([k, label, icon]) => ({ label, icon, radio: true, checked: cfg.view === k, shortcut: `${CMD}⇧${VIEWS.findIndex((v) => v[0] === k) + 1}`, action: () => setViewCfg({ view: k }) })),
      { separator: true },
      { label: 'Compact view', icon: Icons.compact, checked: settings.compact, action: () => toggleSetting('compact') },
    ];
  }
  function sortSubmenu() {
    const cfg = viewCfg();
    const keys = tab().search ? [...SORT_KEYS, ['folder', 'Folder']] : SORT_KEYS;
    return [
      ...keys.map(([k, label]) => ({ label, radio: true, checked: cfg.sortKey === k, action: () => setViewCfg({ sortKey: k }) })),
      { separator: true },
      { label: 'Ascending', radio: true, checked: cfg.sortDir > 0, action: () => setViewCfg({ sortDir: 1 }) },
      { label: 'Descending', radio: true, checked: cfg.sortDir < 0, action: () => setViewCfg({ sortDir: -1 }) },
    ];
  }
  function groupSubmenu() {
    const cfg = viewCfg();
    return [
      ...GROUP_KEYS.map(([k, label]) => ({ label, radio: true, checked: (cfg.groupBy || 'none') === k, action: () => setViewCfg({ groupBy: k }) })),
    ];
  }
  function newSubmenu() {
    return [
      { label: 'Folder', icon: Icons.folderLine, shortcut: `${CMD}⇧N`, action: newFolder },
      { label: 'Shortcut (alias)', icon: Icons.link, action: newShortcut },
      { separator: true },
      { label: 'Text Document', icon: Icons.textDoc, action: () => newFile('New Text Document.txt') },
      { label: 'Rich Text Document', icon: Icons.textDoc, action: () => newFile('New Rich Text Document.rtf', '{\\rtf1\\ansi\\deff0 }') },
      { label: 'Markdown Document', icon: Icons.textDoc, action: () => newFile('New Markdown Document.md') },
      { label: 'HTML Document', icon: Icons.code, action: () => newFile('New HTML Document.html', '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title></title></head>\n<body>\n\n</body>\n</html>\n') },
      { label: 'Shell Script', icon: Icons.terminal, action: () => newFile('New Script.sh', '#!/bin/sh\n\n') },
      { label: 'Compressed (zipped) Folder', icon: Icons.zip, action: () => newFile('New Compressed (zipped) Folder.zip') },
    ];
  }
  async function itemMenu(x, y) {
    const ents = selectedEntries();
    if (!ents.length) return;
    const paths = ents.map((e) => e.path);
    const one = ents.length === 1 ? ents[0] : null;
    const allDirs = ents.every((e) => e.isDir && !e.isPackage);
    const isDrive = one && one.drive;
    const archive = ents.some((e) => ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(e.ext));
    const pinned = paths.every((p) => settings.pins.includes(p));
    const inHome = curLoc() === HOME;
    const iconBar = isDrive ? [] : [
      { icon: Icons.cut, title: `Cut (${CMD}X)`, action: () => copyCut('cut'), disabled: inHome && false },
      { icon: Icons.copy, title: `Copy (${CMD}C)`, action: () => copyCut('copy') },
      { icon: Icons.rename, title: 'Rename (F2)', action: renameSelected, disabled: !one },
      { icon: Icons.share, title: 'Share', action: () => api.share(paths), disabled: !isMac },
      { icon: Icons.trash, title: inHome ? 'Remove from Home' : 'Delete (⌘⌫)', action: () => deleteSelected(false) },
    ];
    const items = [
      { label: 'Open', icon: Icons.open, shortcut: 'Enter', action: () => openPaths(paths) },
      allDirs ? { label: 'Open in new tab', icon: Icons.tab, action: () => paths.forEach((p) => openInNewTab(p, paths.length === 1)) } : null,
      allDirs ? { label: 'Open in new window', icon: Icons.window, action: () => paths.forEach((p) => api.newWindow(p)) } : null,
      !allDirs ? { label: 'Open with', icon: Icons.openWith, submenu: [{ label: 'Choose another app…', action: () => api.openWith(paths) }, { label: 'Visual Studio Code', icon: Icons.code, action: () => paths.forEach((p) => api.openVSCode(p)) }] } : null,
      { separator: true },
      archive ? { label: 'Extract All…', icon: Icons.extract, action: () => extractSelected(false) } : null,
      archive ? { label: 'Extract to…', icon: Icons.extract, action: () => extractSelected(true) } : null,
      !isDrive ? { label: 'Compress to ZIP file', icon: Icons.zip, action: compressSelected } : null,
      allDirs ? { label: pinned ? 'Unpin from Quick access' : 'Pin to Quick access', icon: pinned ? Icons.unpin : Icons.pin, action: () => togglePin(paths) } : null,
      { label: 'Copy as path', icon: Icons.copy, shortcut: `${CMD}⇧C`, action: copyPath },
      isDrive && !one.drive.root ? { label: 'Eject', icon: Icons.eject, action: async () => { try { await api.eject(one.path); reload(); refreshTree(); } catch (err) { alertBox('Eject', err.message, 'error'); } } } : null,
      { separator: true },
      allDirs && one ? { label: 'Open in Terminal', icon: Icons.terminal, action: () => api.terminal(one.path) } : null,
      { label: isMac ? 'Show in Finder' : 'Show in file manager', icon: Icons.finder, action: () => api.reveal(paths[0]) },
      !isDrive && isReal(curLoc()) ? { label: 'Create shortcut', icon: Icons.link, action: async () => { const made = await api.symlink(paths, P.dirname(paths[0])); pushUndo({ type: 'new', label: 'Create shortcut', pairs: made.map((to) => ({ to })) }); afterChange(made); } } : null,
      { separator: true },
      { label: 'Properties', icon: Icons.properties, shortcut: '⌥Enter', action: () => showProperties(paths) },
      isMac && one ? { label: 'Get Info (Finder)', icon: Icons.info, action: () => api.getInfo(one.path) } : null,
    ];
    showMenu(compactSeparators(items), { x, y, iconBar });
  }
  function compactSeparators(items) {
    const out = [];
    for (const it of items) {
      if (!it) continue;
      if (it.separator && (!out.length || out[out.length - 1].separator)) continue;
      out.push(it);
    }
    while (out.length && out[out.length - 1].separator) out.pop();
    return out;
  }
  async function backgroundMenu(x, y) {
    const loc = curLoc();
    const real = isReal(loc) && !tab().search;
    const src = real ? await clipboardSource() : null;
    const items = [
      real || tab().search ? { label: 'View', icon: Icons.view, submenu: viewSubmenu } : null,
      real || tab().search ? { label: 'Sort by', icon: Icons.sort, submenu: sortSubmenu } : null,
      real || tab().search ? { label: 'Group by', icon: Icons.group, submenu: groupSubmenu } : null,
      { label: state.undo.length ? `Undo ${state.undo[state.undo.length - 1].label}` : 'Undo', icon: Icons.undo, shortcut: `${CMD}Z`, disabled: !state.undo.length, action: undo },
      { label: 'Refresh', icon: Icons.refresh, shortcut: `${CMD}R`, action: () => { reload(); refreshTree(); } },
      { separator: true },
      real ? { label: 'Paste', icon: Icons.paste, shortcut: `${CMD}V`, disabled: !src, action: () => paste() } : null,
      real ? { label: 'Paste shortcut', icon: Icons.link, disabled: !src, action: pasteShortcut } : null,
      { separator: true },
      real ? { label: 'Open in Terminal', icon: Icons.terminal, action: () => api.terminal(loc) } : null,
      real && isMac ? { label: 'Show in Finder', icon: Icons.finder, action: () => api.open(loc) } : null,
      { separator: true },
      real ? { label: 'New', icon: Icons.newItem, submenu: newSubmenu } : null,
      { separator: true },
      real ? { label: 'Properties', icon: Icons.properties, action: () => showProperties([loc]) } : null,
      loc === TRASH ? { label: 'Empty Recycle Bin', icon: Icons.trash, action: emptyTrash } : null,
    ];
    showMenu(compactSeparators(items), { x, y });
  }
  async function emptyTrash() {
    const ok = await api.emptyTrash();
    if (ok) { toast('Recycle Bin emptied'); reload(); }
  }

  /* ================================================================== */
  /* Command bar                                                         */
  /* ================================================================== */
  function cmdBtn(icon, label, opts = {}) {
    const b = el('button', {
      class: 'cmd' + (opts.label ? ' with-label' : '') + (opts.dropdown ? ' dropdown' : '') + (opts.active ? ' active' : ''),
      title: opts.title || label, disabled: opts.disabled,
      onclick: (e) => { if (opts.menu) { showMenu(typeof opts.menu === 'function' ? opts.menu() : opts.menu, { anchor: e.currentTarget }); } else opts.action && opts.action(); },
    }, el('span', { class: 'cmd-icon', html: icon }), opts.label ? el('span', { class: 'cmd-label', text: label }) : null, opts.dropdown ? el('span', { class: 'cmd-caret', html: Icons.chevronDown }) : null);
    return b;
  }
  function renderCommandBar() {
    const bar = $('#commandbar');
    bar.innerHTML = '';
    const loc = curLoc();
    const real = isReal(loc) && !tab().search;
    const sel = selectedEntries();
    const has = sel.length > 0;
    const anyDrive = sel.some((e) => e.drive);
    const listing = real || tab().search;
    const inTrash = real && loc.startsWith(TRASH);
    bar.append(
      cmdBtn(Icons.newItem, 'New', { label: true, dropdown: true, disabled: !real, menu: newSubmenu, title: 'Create a new item in the current location' }),
      el('span', { class: 'cmd-sep' }),
      cmdBtn(Icons.cut, 'Cut', { disabled: !has || anyDrive, action: () => copyCut('cut'), title: `Cut (${CMD}X)` }),
      cmdBtn(Icons.copy, 'Copy', { disabled: !has || anyDrive, action: () => copyCut('copy'), title: `Copy (${CMD}C)` }),
      cmdBtn(Icons.paste, 'Paste', { disabled: !real, action: () => paste(), title: `Paste (${CMD}V)` }),
      cmdBtn(Icons.rename, 'Rename', { disabled: sel.length !== 1 || anyDrive || loc === THISPC, action: renameSelected, title: 'Rename (F2)' }),
      cmdBtn(Icons.share, 'Share', { disabled: !has || anyDrive || !isMac, action: () => api.share(selected()), title: 'Share' }),
      cmdBtn(Icons.trash, 'Delete', { disabled: !has || anyDrive || loc === THISPC, action: () => deleteSelected(false), title: 'Delete (⌘⌫)' }),
      el('span', { class: 'cmd-sep' }),
      cmdBtn(Icons.sort, 'Sort', { label: true, dropdown: true, disabled: !listing, menu: () => [...sortSubmenu(), { separator: true }, { label: 'Group by', icon: Icons.group, submenu: groupSubmenu }] }),
      cmdBtn(Icons.view, 'View', {
        label: true, dropdown: true, disabled: !listing,
        menu: () => [...viewSubmenu(), { separator: true }, {
          label: 'Show', icon: Icons.show, submenu: () => [
            { label: 'Navigation pane', checked: !state.navHidden, action: toggleNav },
            { label: 'Details pane', checked: settings.pane === 'details', action: () => setPane('details'), shortcut: '⌥⇧P' },
            { label: 'Preview pane', checked: settings.pane === 'preview', action: () => setPane('preview'), shortcut: '⌥P' },
            { separator: true },
            { label: 'Item check boxes', checked: settings.itemCheckboxes, action: () => toggleSetting('itemCheckboxes') },
            { label: 'File name extensions', checked: !settings.hideExtensions, action: () => toggleSetting('hideExtensions') },
            { label: 'Hidden items', checked: settings.showHidden, action: () => toggleSetting('showHidden'), shortcut: '⌘⇧.' },
          ],
        }],
      }),
    );
    if (inTrash) bar.append(el('span', { class: 'cmd-sep' }), cmdBtn(Icons.trash, 'Empty Recycle Bin', { label: true, action: emptyTrash }));
    if (sel.some((e) => ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(e.ext))) bar.append(el('span', { class: 'cmd-sep' }), cmdBtn(Icons.extract, 'Extract all', { label: true, action: () => extractSelected(false) }));
    bar.append(
      cmdBtn(Icons.more, 'See more', {
        menu: () => compactSeparators([
          { label: state.undo.length ? `Undo ${state.undo[state.undo.length - 1].label}` : 'Undo', icon: Icons.undo, shortcut: `${CMD}Z`, disabled: !state.undo.length, action: undo },
          { label: 'Redo', icon: Icons.redo, shortcut: `${CMD}⇧Z`, disabled: !state.redo.length, action: redo },
          { separator: true },
          { label: has && sel.every((e) => e.isDir) && sel.every((e) => settings.pins.includes(e.path)) ? 'Unpin from Quick access' : 'Pin to Quick access', icon: Icons.pin, disabled: !(has ? sel.every((e) => e.isDir && !e.isPackage) : real), action: () => togglePin(has ? selected() : [loc]) },
          { separator: true },
          { label: 'Select all', icon: Icons.selectAll, shortcut: `${CMD}A`, action: selectAll },
          { label: 'Select none', icon: Icons.selectNone, action: selectNone },
          { label: 'Invert selection', icon: Icons.invert, action: invertSelection },
          { separator: true },
          { label: 'Compress to ZIP file', icon: Icons.zip, disabled: !has || anyDrive, action: compressSelected },
          { label: 'Copy path', icon: Icons.copy, action: copyPath },
          { label: 'Open in Terminal', icon: Icons.terminal, disabled: !real, action: () => api.terminal(loc) },
          { label: 'Open new window', icon: Icons.window, shortcut: `${CMD}N`, action: () => api.newWindow(isReal(loc) ? loc : undefined) },
          { separator: true },
          { label: 'Properties', icon: Icons.properties, disabled: !has && !real, action: () => showProperties(has ? selected() : [loc]) },
          { label: 'Options', icon: Icons.options, shortcut: `${CMD},`, action: showOptions },
        ]),
      }),
      el('span', { class: 'cmd-fill' }),
      cmdBtn(settings.pane === 'preview' ? Icons.previewPane : Icons.detailsPane, settings.pane === 'preview' ? 'Preview' : 'Details', {
        label: true, active: settings.pane !== 'none',
        action: () => setPane(settings.pane === 'none' ? 'details' : settings.pane),
        title: settings.pane === 'preview' ? 'Preview pane (⌥P)' : 'Details pane (⌥⇧P)',
      }),
    );
    // Back/forward state
    const t = tab();
    $('#btn-back').disabled = !(t.hi > 0 || t.search);
    $('#btn-forward').disabled = !(t.hi < t.history.length - 1);
    $('#btn-up').disabled = loc === HOME && !t.search;
  }

  /* ================================================================== */
  /* Address bar & search                                                */
  /* ================================================================== */
  function crumbChain(loc) {
    if (loc === HOME) return [{ loc: HOME, label: 'Home' }];
    if (loc === THISPC) return [{ loc: THISPC, label: 'This PC' }];
    const chain = [];
    if (loc === TRASH) return [{ loc: TRASH, label: 'Recycle Bin' }];
    if (loc.startsWith(info.home + '/') || loc === info.home) {
      chain.push({ loc: HOME, label: 'Home' });
      chain.push({ loc: info.home, label: info.user });
      let cur = info.home;
      for (const seg of loc.slice(info.home.length).split('/').filter(Boolean)) { cur += '/' + seg; chain.push({ loc: cur, label: locName(cur) === seg ? seg : locName(cur) }); }
      return chain;
    }
    chain.push({ loc: THISPC, label: 'This PC' });
    const vol = state.volumes.filter((v) => !v.root).find((v) => loc === v.path || loc.startsWith(v.path + '/'));
    let cur = vol ? vol.path : '/';
    chain.push({ loc: cur, label: vol ? vol.name : 'Macintosh HD' });
    for (const seg of loc.slice(cur.length).split('/').filter(Boolean)) { cur = cur === '/' ? '/' + seg : cur + '/' + seg; chain.push({ loc: cur, label: seg }); }
    return chain;
  }
  function renderAddress() {
    const t = tab();
    const c = $('#crumbs');
    c.innerHTML = '';
    const chain = t.search ? [...crumbChain(t.search.root), { loc: null, label: `Search Results in ${locName(t.search.root)}` }] : crumbChain(t.loc);
    const root = t.search ? t.search.root : t.loc;
    c.append(el('span', { class: 'crumb-icon', html: t.search ? Icons.search : locIconHtml(chain[0].loc === HOME && chain.length > 1 ? root : chain[0].loc, 16) }));
    const overflow = el('button', { class: 'crumb-overflow icon-btn small', html: '«', title: 'Show hidden locations' });
    c.append(overflow);
    const parts = [];
    chain.forEach((ch, i) => {
      const sep = el('button', { class: 'crumb-sep', html: Icons.chevronRight, title: 'Show subfolders' });
      if (ch.loc && isReal(ch.loc)) {
        sep.addEventListener('click', async (e) => {
          e.stopPropagation();
          const subs = await api.subdirs(ch.loc, settings.showHidden);
          sep.classList.add('open');
          showMenu(subs.length ? subs.slice(0, 300).map((s) => ({ label: s.name, icon: Icons.folderSvg(Icons.badges[SPECIAL[s.path]] || '', 16), checked: chain[i + 1] && chain[i + 1].loc === s.path, action: () => navigate(s.path) })) : [{ label: '(empty)', disabled: true }],
            { anchor: sep, onClose: () => sep.classList.remove('open'), className: 'scroll' });
        });
      } else if (ch.loc === THISPC) {
        sep.addEventListener('click', async (e) => {
          e.stopPropagation();
          showMenu([...state.volumes.map((v) => ({ label: v.name, icon: Icons.driveSvg(v.root ? 'hdd' : 'usb', 16), action: () => navigate(v.path) }))], { anchor: sep });
        });
      } else if (ch.loc === HOME) {
        sep.addEventListener('click', (e) => {
          e.stopPropagation();
          showMenu(settings.pins.map((p) => ({ label: locName(p), icon: Icons.folderSvg(Icons.badges[SPECIAL[p]] || '', 16), action: () => navigate(p) })), { anchor: sep });
        });
      }
      const b = el('button', { class: 'crumb' + (i === chain.length - 1 ? ' last' : ''), text: ch.label, onclick: (e) => { e.stopPropagation(); if (ch.loc) navigate(ch.loc); } });
      if (ch.loc && isReal(ch.loc)) {
        b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); b.classList.add('drop'); } });
        b.addEventListener('dragleave', () => b.classList.remove('drop'));
        b.addEventListener('drop', (e) => { b.classList.remove('drop'); handleDrop(e, ch.loc); });
      }
      if (i > 0) { c.append(sep); parts.push([sep, b]); c.append(b); } else { c.append(b); c.append(sep); parts.push([null, b, sep]); }
    });
    // collapse leading crumbs if overflowing
    const hidden = [];
    overflow.style.display = 'none';
    let guard = 0;
    while (c.scrollWidth > c.clientWidth && hidden.length < chain.length - 1 && guard++ < 50) {
      const i = hidden.length;
      const p = parts[i];
      p.forEach((x) => x && (x.style.display = 'none'));
      hidden.push(chain[i]);
      overflow.style.display = '';
    }
    overflow.onclick = (e) => { e.stopPropagation(); showMenu(hidden.slice().reverse().map((h) => ({ label: h.label, icon: locIconHtml(h.loc, 16), action: () => navigate(h.loc) })), { anchor: overflow }); };
    $('#search-input').placeholder = `Search ${locName(root)}`;
  }
  function editAddress() {
    const a = $('#address');
    const input = $('#address-input');
    const t = tab();
    a.classList.add('editing');
    const loc = t.search ? t.search.root : t.loc;
    input.value = isReal(loc) ? loc : locName(loc);
    input.focus(); input.select();
  }
  $('#address').addEventListener('mousedown', (e) => {
    if (e.target.closest('.crumb, .crumb-sep, .crumb-overflow') || $('#address').classList.contains('editing')) return;
    e.preventDefault();
    editAddress();
  });
  const addrInput = $('#address-input');
  addrInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const loc = resolveInput(addrInput.value);
      $('#address').classList.remove('editing');
      content.focus();
      if (loc) navigate(loc);
    } else if (e.key === 'Escape') {
      e.preventDefault(); $('#address').classList.remove('editing'); content.focus();
    } else if (e.key === 'Tab') {
      // path completion
      e.preventDefault();
      const v = addrInput.value;
      const full = resolveInput(v.endsWith('/') ? v + 'x' : v);
      if (!full) return;
      const dir = v.endsWith('/') ? P.dirname(full) : P.dirname(full);
      const prefix = v.endsWith('/') ? '' : P.basename(full).toLowerCase();
      const subs = (await api.subdirs(dir, settings.showHidden)).filter((s) => s.name.toLowerCase().startsWith(prefix));
      if (subs.length === 1) addrInput.value = subs[0].path + '/';
      else if (subs.length > 1) {
        showMenu(subs.slice(0, 50).map((s) => ({ label: s.name, icon: Icons.folderSvg('', 16), action: () => { addrInput.value = s.path + '/'; addrInput.focus(); } })), { anchor: addrInput });
      }
    }
  });
  addrInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== addrInput && !document.querySelector('.menu')) $('#address').classList.remove('editing'); }, 150));

  let searchSeq = 0, searchTimer = null;
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    $('#search').classList.toggle('has-text', !!searchInput.value);
    searchTimer = setTimeout(() => runSearch(searchInput.value), 350);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(searchInput.value); }
    if (e.key === 'Escape') { e.preventDefault(); clearSearch(); content.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); content.focus(); moveFocus('home', e); }
  });
  $('#search-clear').addEventListener('click', () => { clearSearch(); searchInput.focus(); });
  function runSearch(q) {
    const t = tab();
    q = q.trim();
    if (!q) { clearSearch(); return; }
    const root = t.search ? t.search.root : (isReal(t.loc) ? t.loc : info.home);
    if (t.search) api.searchCancel(t.search.id);
    const id = ++searchSeq;
    t.search = { id, query: q, root, results: [], done: false };
    t.sel = new Set(); t.focus = null;
    renderTabs();
    loadLocation();
    api.searchStart({ id, root, query: q, showHidden: settings.showHidden });
  }
  function clearSearch() {
    const t = tab();
    searchInput.value = '';
    $('#search').classList.remove('has-text');
    if (!t.search) return;
    api.searchCancel(t.search.id);
    t.search = null;
    renderTabs();
    loadLocation({ restoreScroll: true });
  }
  let searchRenderTimer = null;
  api.onSearchResults(({ id, items }) => {
    const t = state.tabs.find((x) => x.search && x.search.id === id);
    if (!t) return;
    t.search.results.push(...items);
    if (t === tab()) {
      clearTimeout(searchRenderTimer);
      searchRenderTimer = setTimeout(() => { state.all = t.search.results; applyView(); }, 120);
    }
  });
  api.onSearchDone(({ id }) => {
    const t = state.tabs.find((x) => x.search && x.search.id === id);
    if (!t) return;
    t.search.done = true;
    if (t === tab()) { state.all = t.search.results; applyView(); }
  });

  function updateChrome() {
    renderAddress();
    renderCommandBar();
    const t = tab();
    searchInput.value = t.search ? t.search.query : '';
    $('#search').classList.toggle('has-text', !!t.search);
  }

  /* ================================================================== */
  /* Navigation pane                                                     */
  /* ================================================================== */
  function navNode({ key, loc, label, icon, depth = 0, expandable = false, pinned = false, onClick, drive }) {
    const expanded = state.tree.expanded.has(key);
    const n = el('div', { class: 'nav-item', 'data-loc': loc || '', 'data-key': key, style: { paddingLeft: 6 + depth * 14 + 'px' }, tabindex: -1 },
      el('span', { class: 'nav-chev' + (expandable ? '' : ' none') + (expanded ? ' open' : ''), html: expandable ? Icons.chevronRight : '' }),
      el('span', { class: 'nav-icon', html: icon }),
      el('span', { class: 'nav-label', text: label }),
      pinned ? el('span', { class: 'nav-pin', html: Icons.pin, title: 'Pinned' }) : null,
      drive && !drive.root ? el('button', { class: 'nav-eject icon-btn small', html: Icons.eject, title: 'Eject', onclick: async (e) => { e.stopPropagation(); try { await api.eject(drive.path); refreshTree(); } catch (err) { alertBox('Eject', err.message, 'error'); } } }) : null);
    n.addEventListener('click', (e) => {
      if (e.target.closest('.nav-chev') && expandable) { toggleNode(key, loc); return; }
      if (onClick) onClick(); else if (loc) { if (e.metaKey || e.ctrlKey) openInNewTab(loc); else navigate(loc); }
    });
    n.addEventListener('dblclick', (e) => { if (expandable && !e.target.closest('.nav-chev')) toggleNode(key, loc); });
    n.addEventListener('auxclick', (e) => { if (e.button === 1 && loc) openInNewTab(loc, false); });
    n.addEventListener('contextmenu', (e) => { e.preventDefault(); if (loc) navMenu(e, loc, { pinned, drive }); });
    if (loc && isReal(loc)) {
      let t = null;
      n.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault(); e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move';
        n.classList.add('drop');
        if (expandable && !expanded && !t) t = setTimeout(() => toggleNode(key, loc, true), 900);
      });
      n.addEventListener('dragleave', () => { n.classList.remove('drop'); clearTimeout(t); t = null; });
      n.addEventListener('drop', (e) => { n.classList.remove('drop'); clearTimeout(t); t = null; handleDrop(e, loc); });
    }
    return n;
  }
  async function toggleNode(key, loc, forceOpen = false) {
    if (state.tree.expanded.has(key) && !forceOpen) state.tree.expanded.delete(key);
    else {
      state.tree.expanded.add(key);
      if (loc && isReal(loc) && !state.tree.children.has(loc)) state.tree.children.set(loc, await api.subdirs(loc, settings.showHidden));
    }
    renderNav();
  }
  async function refreshTreeNode(loc) {
    state.tree.children.set(loc, await api.subdirs(loc, settings.showHidden));
    renderNav();
  }
  async function refreshTree() {
    state.volumes = await api.volumes();
    const locs = [...state.tree.children.keys()];
    await Promise.all(locs.map(async (l) => state.tree.children.set(l, await api.subdirs(l, settings.showHidden))));
    renderNav();
  }
  function renderSubtree(parentKey, loc, depth, out) {
    const kids = state.tree.children.get(loc) || [];
    for (const k of kids) {
      const key = parentKey + '>' + k.path;
      out.push(navNode({ key, loc: k.path, label: locName(k.path), icon: Icons.folderSvg(Icons.badges[SPECIAL[k.path]] || '', 16), depth, expandable: true }));
      if (state.tree.expanded.has(key)) renderSubtree(key, k.path, depth + 1, out);
    }
  }
  function renderNav() {
    const nav = $('#navpane');
    const scroll = nav.scrollTop;
    nav.innerHTML = '';
    const out = [];
    out.push(navNode({ key: 'home', loc: HOME, label: 'Home', icon: Icons.homeSvg(16) }));
    out.push(el('div', { class: 'nav-sep' }));
    for (const p of settings.pins) {
      const key = 'pin>' + p;
      out.push(navNode({ key, loc: p, label: locName(p), icon: Icons.folderSvg(Icons.badges[SPECIAL[p]] || '', 16), pinned: true, expandable: true }));
      if (state.tree.expanded.has(key)) renderSubtree(key, p, 1, out);
    }
    out.push(el('div', { class: 'nav-sep' }));
    // user folder
    const ukey = 'user';
    out.push(navNode({ key: ukey, loc: info.home, label: info.user, icon: Icons.folderSvg(Icons.badges.home, 16), expandable: true }));
    if (state.tree.expanded.has(ukey)) renderSubtree(ukey, info.home, 1, out);
    // This PC
    out.push(navNode({ key: 'thispc', loc: THISPC, label: 'This PC', icon: Icons.pcSvg(16), expandable: true }));
    if (state.tree.expanded.has('thispc')) {
      for (const v of state.volumes) {
        const key = 'vol>' + v.path;
        out.push(navNode({ key, loc: v.path, label: v.root ? `${v.name}` : v.name, icon: Icons.driveSvg(v.root ? 'hdd' : 'usb', 16), depth: 1, expandable: true, drive: v }));
        if (state.tree.expanded.has(key)) renderSubtree(key, v.path, 2, out);
      }
    }
    out.push(el('div', { class: 'nav-sep' }));
    out.push(navNode({ key: 'trash', loc: TRASH, label: 'Recycle Bin', icon: Icons.trashSvg(false, 16) }));
    nav.append(...out);
    nav.scrollTop = scroll;
    renderNavSelection();
  }
  function renderNavSelection() {
    const loc = tab() && (tab().search ? null : curLoc());
    let found = false;
    for (const n of $$('.nav-item', $('#navpane'))) {
      const on = !found && n.dataset.loc === loc;
      n.classList.toggle('active', on);
      if (on) found = true;
    }
  }
  function navMenu(e, loc, { pinned, drive }) {
    const real = isReal(loc);
    showMenu(compactSeparators([
      { label: 'Open', icon: Icons.open, action: () => navigate(loc) },
      { label: 'Open in new tab', icon: Icons.tab, action: () => openInNewTab(loc) },
      { label: 'Open in new window', icon: Icons.window, action: () => api.newWindow(loc) },
      { separator: true },
      real && loc !== TRASH ? { label: pinned || settings.pins.includes(loc) ? 'Unpin from Quick access' : 'Pin to Quick access', icon: pinned ? Icons.unpin : Icons.pin, action: () => togglePin([loc]) } : null,
      pinned ? { label: 'Move up', disabled: settings.pins.indexOf(loc) === 0, action: () => movePin(loc, -1) } : null,
      pinned ? { label: 'Move down', disabled: settings.pins.indexOf(loc) === settings.pins.length - 1, action: () => movePin(loc, 1) } : null,
      loc === TRASH ? { label: 'Empty Recycle Bin', icon: Icons.trash, action: emptyTrash } : null,
      drive && !drive.root ? { label: 'Eject', icon: Icons.eject, action: () => api.eject(drive.path).then(refreshTree) } : null,
      { separator: true },
      real ? { label: 'Paste', icon: Icons.paste, action: () => paste(loc) } : null,
      real ? { label: 'Copy as path', icon: Icons.copy, action: () => { api.clipWriteText(loc); toast('Path copied'); } } : null,
      real ? { label: 'Open in Terminal', icon: Icons.terminal, action: () => api.terminal(loc) } : null,
      real ? { label: isMac ? 'Show in Finder' : 'Show in file manager', icon: Icons.finder, action: () => api.reveal(loc) } : null,
      { separator: true },
      real ? { label: 'Properties', icon: Icons.properties, action: () => showProperties([loc]) } : null,
      loc === HOME ? { label: 'Options', icon: Icons.options, action: showOptions } : null,
    ]), { x: e.clientX, y: e.clientY });
  }
  function movePin(loc, d) {
    const i = settings.pins.indexOf(loc);
    const j = i + d;
    if (j < 0 || j >= settings.pins.length) return;
    const pins = settings.pins.slice();
    [pins[i], pins[j]] = [pins[j], pins[i]];
    saveSettings({ pins });
    renderNav();
    if (curLoc() === HOME) reload();
  }
  $('#navpane').addEventListener('keydown', (e) => {
    const items = $$('.nav-item', $('#navpane'));
    let i = items.indexOf(document.activeElement);
    if (i < 0) i = items.findIndex((n) => n.classList.contains('active'));
    const cur = items[i];
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)]?.focus(); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); cur.click(); }
    else if (e.key === 'ArrowRight' && cur) { e.preventDefault(); const ch = $('.nav-chev:not(.none):not(.open)', cur); if (ch) toggleNode(cur.dataset.key, cur.dataset.loc).then(() => $(`.nav-item[data-key="${CSS.escape(cur.dataset.key)}"]`)?.focus()); }
    else if (e.key === 'ArrowLeft' && cur) { e.preventDefault(); const ch = $('.nav-chev.open', cur); if (ch) toggleNode(cur.dataset.key, cur.dataset.loc).then(() => $(`.nav-item[data-key="${CSS.escape(cur.dataset.key)}"]`)?.focus()); }
  });
  function toggleNav() {
    state.navHidden = !state.navHidden;
    layoutPanes();
  }

  /* ================================================================== */
  /* Preview / Details pane                                              */
  /* ================================================================== */
  let paneTimer = null, paneToken = 0;
  function schedulePane() { clearTimeout(paneTimer); paneTimer = setTimeout(renderPane, 80); }
  async function buildPreview(e, host, big = false) {
    const kind = kindOf(e.ext);
    const url = P.toUrl(e.path);
    if (e.isDir && !e.isPackage) {
      host.append(el('div', { class: 'pv-icon', html: e.drive ? Icons.driveSvg(e.drive.root ? 'hdd' : 'usb', 128) : folderIcon(e, 128) }));
      return true;
    }
    if (kind === 'image') {
      const img = el('img', { class: 'pv-media', src: url, draggable: 'false' });
      img.onerror = async () => { const t = await api.thumb(e.path, 800); if (t) img.src = t; };
      host.append(img);
      return true;
    }
    if (kind === 'video') { host.append(el('video', { class: 'pv-media', src: url, controls: true, autoplay: big, muted: !big })); return true; }
    if (kind === 'audio') {
      const th = await api.thumb(e.path, 256);
      host.append(el('div', { class: 'pv-audio' }, th ? el('img', { src: th, class: 'pv-art' }) : el('div', { class: 'pv-icon', html: Icons.genericFileSvg(e.ext, 96) }), el('audio', { src: url, controls: true })));
      return true;
    }
    if (kind === 'pdf') { host.append(el('iframe', { class: 'pv-frame', src: url + '#toolbar=0&view=FitH' })); return true; }
    if ((kind === 'text' || kind === 'code' || !e.ext || e.size < 512 * 1024) && e.size < 20 * 1024 * 1024 && e.ext !== 'rtf' && !['zip', 'dmg', 'pkg'].includes(e.ext) && !e.isPackage) {
      try {
        const r = await api.readText(e.path, big ? 1024 * 1024 : 128 * 1024);
        if (r.text != null) {
          if (e.ext === 'html' || e.ext === 'htm' || e.ext === 'svg') {
            host.append(el('iframe', { class: 'pv-frame', sandbox: '', src: url }));
          } else {
            host.append(el('pre', { class: 'pv-text' + (kind === 'code' ? ' code' : ''), text: r.text + (r.truncated ? '\n…' : '') }));
          }
          return true;
        }
      } catch {}
    }
    const th = await api.thumb(e.path, big ? 1024 : 512);
    if (th) { host.append(el('img', { class: 'pv-media ql', src: th })); return true; }
    return false;
  }
  async function renderPane() {
    const pane = $('#sidepane');
    if (settings.pane === 'none') { pane.innerHTML = ''; return; }
    const token = ++paneToken;
    const sel = selectedEntries();
    const t = tab();
    pane.innerHTML = '';
    if (settings.pane === 'preview') {
      if (sel.length !== 1) { pane.append(el('div', { class: 'pane-msg', text: sel.length ? 'Select a single file to preview.' : 'Select a file to preview.' })); return; }
      const box = el('div', { class: 'pv' });
      pane.append(box);
      const ok = await buildPreview(sel[0], box);
      if (token !== paneToken) return;
      if (!ok) box.append(el('div', { class: 'pane-msg', text: 'No preview available.' }));
      return;
    }
    // details pane
    const wrap = el('div', { class: 'dp' });
    pane.append(wrap);
    let ents = sel;
    let headerOnly = false;
    if (!ents.length) {
      if (isReal(t.loc) && !t.search) { try { ents = [await api.stat(t.loc)]; } catch { ents = []; } headerOnly = false; }
      else {
        wrap.append(el('div', { class: 'dp-icon', html: locIconHtml(t.search ? t.search.root : t.loc, 96) }), el('div', { class: 'dp-name', text: t.search ? tabTitle(t) : locName(t.loc) }), el('div', { class: 'dp-sub', text: plural(state.items.length, 'item') }));
        return;
      }
    }
    if (token !== paneToken) return;
    if (ents.length === 1) {
      const e = ents[0];
      const iconBox = el('div', { class: 'dp-icon' });
      wrap.append(iconBox);
      if (e.isDir && !e.isPackage) iconBox.innerHTML = e.drive ? Icons.driveSvg(e.drive.root ? 'hdd' : 'usb', 96) : folderIcon(e, 96);
      else {
        iconBox.innerHTML = Icons.genericFileSvg(e.ext, 96);
        api.thumb(e.path, 384).then((u) => { if (u && token === paneToken) { iconBox.innerHTML = ''; iconBox.append(el('img', { src: u })); } else if (!u) api.icon(e.path, 'normal').then((i) => { if (i && token === paneToken) { iconBox.innerHTML = ''; iconBox.append(el('img', { src: i, class: 'small' })); } }); });
      }
      wrap.append(el('div', { class: 'dp-name', text: displayName(e) }), el('div', { class: 'dp-sub', text: typeName(e) }));
      const rows = [];
      if (e.drive) {
        rows.push(['Space used', fmtSize(e.drive.total - e.drive.free)], ['Free space', fmtSize(e.drive.free)], ['Total size', fmtSize(e.drive.total)]);
      } else {
        rows.push(['Date modified', fmtDate(e.mtime)]);
        if (!e.isDir || e.isPackage) rows.push(['Size', fmtSize(e.size)]);
        rows.push(['Date created', fmtDate(e.btime)]);
        if (!headerOnly) rows.push(['Location', P.dirname(e.path)]);
        if (kindOf(e.ext) === 'image') {
          const dim = await api.imageSize(e.path);
          if (token !== paneToken) return;
          if (dim) rows.push(['Dimensions', `${dim.width} x ${dim.height}`]);
        }
        rows.push(['Attributes', (e.mode & 0o200 ? '' : 'Read-only ') + (e.hidden ? 'Hidden' : '') || 'Normal']);
      }
      const dl = el('div', { class: 'dp-props' });
      for (const [k, v] of rows) dl.append(el('div', { class: 'dp-k', text: k }), el('div', { class: 'dp-v', text: v, title: v }));
      wrap.append(dl);
      if (e.isDir && !e.drive) {
        const sizeRow = el('div', { class: 'dp-v', text: 'Calculating…' });
        dl.append(el('div', { class: 'dp-k', text: 'Contains' }), sizeRow);
        api.folderStats([e.path]).then((s) => { if (token === paneToken) sizeRow.textContent = `${plural(s.files, 'File')}, ${plural(Math.max(0, s.folders - 1), 'Folder')} (${fmtSize(s.bytes)})${s.partial ? '+' : ''}`; });
      }
    } else {
      wrap.append(el('div', { class: 'dp-icon multi', html: Icons.genericFileSvg('', 80) + Icons.genericFileSvg('', 80) }), el('div', { class: 'dp-name', text: `${ents.length} items selected` }));
      const total = ents.reduce((s, e) => s + (e.isDir ? 0 : e.size), 0);
      const dl = el('div', { class: 'dp-props' });
      dl.append(el('div', { class: 'dp-k', text: 'Total file size' }), el('div', { class: 'dp-v', text: fmtSize(total) }));
      const dates = ents.map((e) => e.mtime).filter(Boolean).sort();
      if (dates.length) dl.append(el('div', { class: 'dp-k', text: 'Date modified' }), el('div', { class: 'dp-v', text: `${fmtDate(dates[0])} - ${fmtDate(dates[dates.length - 1])}` }));
      wrap.append(dl);
    }
  }

  /* ---------- Peek (Space) — Quick Look style overlay ---------- */
  async function peek(p) {
    let idx = state.items.findIndex((e) => e.path === p);
    if (idx < 0) return;
    const ov = el('div', { class: 'peek', tabindex: 0 });
    const head = el('div', { class: 'peek-head' });
    const body = el('div', { class: 'peek-body' });
    ov.append(el('div', { class: 'peek-card' }, head, body));
    document.body.append(ov);
    const show = async () => {
      const e = state.items[idx];
      selectOnly(e.path); revealItem(e.path);
      head.innerHTML = '';
      head.append(el('span', { class: 'peek-title', text: displayName(e) }), el('span', { class: 'peek-sub', text: `${typeName(e)}${e.isDir ? '' : ' · ' + fmtSize(e.size)}` }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', text: 'Open', onclick: () => { close(); openPaths([e.path]); } }),
        el('button', { class: 'icon-btn small', html: Icons.close, onclick: () => close() }));
      body.innerHTML = '';
      const ok = await buildPreview(e, body, true);
      if (!ok) body.append(el('div', { class: 'pv-icon', html: Icons.genericFileSvg(e.ext, 160) }));
    };
    const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); content.focus(); };
    const key = (ev) => {
      if (ev.key === 'Escape' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); close(); }
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') { ev.preventDefault(); ev.stopPropagation(); if (idx < state.items.length - 1) { idx++; show(); } }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); ev.stopPropagation(); if (idx > 0) { idx--; show(); } }
      else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); const e = state.items[idx]; close(); openPaths([e.path]); }
    };
    ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });
    document.addEventListener('keydown', key, true);
    ov.focus();
    show();
  }

  /* ================================================================== */
  /* Status bar                                                          */
  /* ================================================================== */
  function renderStatus() {
    const t = tab();
    const n = state.items.length;
    $('#status-count').textContent = state.error ? '' : plural(n, 'item') + (t.search && !t.search.done ? '  (searching…)' : '');
    const sel = selectedEntries();
    if (sel.length) {
      const files = sel.filter((e) => !e.isDir);
      const size = files.reduce((s, e) => s + e.size, 0);
      $('#status-sel').textContent = `${plural(sel.length, 'item')} selected${files.length ? '  ' + fmtSize(size) : ''}`;
    } else $('#status-sel').textContent = '';
    const v = viewCfg().view;
    $('#sb-details').classList.toggle('active', v === 'details');
    $('#sb-large').classList.toggle('active', v === 'large');
  }
  $('#sb-details').innerHTML = Icons.vDetails;
  $('#sb-large').innerHTML = Icons.vLarge;
  $('#sb-details').addEventListener('click', () => setViewCfg({ view: 'details' }));
  $('#sb-large').addEventListener('click', () => setViewCfg({ view: 'large' }));

  /* ================================================================== */
  /* Progress (copy/move)                                                */
  /* ================================================================== */
  const ops = new Map();
  api.onOpStart(({ id, mode, count, dest }) => {
    const o = { id, mode, count, dest, shown: false, el: null, last: null };
    o.timer = setTimeout(() => showOp(o), 500);
    ops.set(id, o);
  });
  api.onOpProgress((p) => { const o = ops.get(p.id); if (!o) return; o.last = p; if (o.el) updateOp(o); });
  api.onOpEnd(({ id }) => { const o = ops.get(id); if (!o) return; clearTimeout(o.timer); if (o.el) o.el.remove(); ops.delete(id); });
  function showOp(o) {
    o.el = el('div', { class: 'op' },
      el('div', { class: 'op-title' }, el('span', { class: 'op-text' }), el('button', { class: 'icon-btn small', title: 'Cancel', html: Icons.close, onclick: () => api.cancelOp(o.id) })),
      el('div', { class: 'op-bar' }, el('span')),
      el('div', { class: 'op-sub' }));
    $('#progress-layer').append(o.el);
    updateOp(o);
  }
  function updateOp(o) {
    const p = o.last;
    const pct = p && p.totalBytes ? Math.min(100, (p.doneBytes / p.totalBytes) * 100) : (p && p.totalFiles ? (p.doneFiles / p.totalFiles) * 100 : 0);
    $('.op-text', o.el).textContent = `${o.mode === 'copy' ? 'Copying' : 'Moving'} ${plural(o.count, 'item')} to ${locName(o.dest)} — ${Math.floor(pct)}% complete`;
    $('.op-bar span', o.el).style.width = pct + '%';
    $('.op-sub', o.el).textContent = p ? `${p.current || ''}  ${fmtSize(p.doneBytes)} of ${fmtSize(p.totalBytes)}` : 'Calculating…';
  }

  /* ================================================================== */
  /* Properties & Options dialogs                                        */
  /* ================================================================== */
  async function showProperties(paths) {
    paths = paths.filter((p) => isReal(p));
    if (!paths.length) return;
    if (paths.length === 1) {
      let e;
      try { e = await api.stat(paths[0]); } catch (err) { alertBox('Properties', err.message, 'error'); return; }
      const vol = state.volumes.find((v) => v.path === e.path);
      const hiddenFlag = await api.isHiddenFlag(e.path).catch(() => false);
      const nameInput = el('input', { class: 'prop-name', value: e.path === '/' ? 'Macintosh HD' : e.name, disabled: e.path === '/' || !!vol });
      const ro = el('input', { type: 'checkbox', checked: !(e.mode & 0o200) });
      const hid = el('input', { type: 'checkbox', checked: e.name.startsWith('.') || hiddenFlag, disabled: e.name.startsWith('.') });
      const sizeV = el('span', { text: e.isDir && !e.isPackage ? 'Calculating…' : `${fmtSize(e.size)} (${e.size.toLocaleString()} bytes)` });
      const diskV = el('span', { text: 'Calculating…' });
      const containsV = el('span', { text: 'Calculating…' });
      const iconBox = el('span', { class: 'prop-icon', html: e.isDir && !e.isPackage ? (vol ? Icons.driveSvg(vol.root ? 'hdd' : 'usb', 40) : folderIcon(e, 40)) : Icons.genericFileSvg(e.ext, 40) });
      if (!e.isDir || e.isPackage) api.icon(e.path, 'normal').then((u) => { if (u) { iconBox.innerHTML = ''; iconBox.append(el('img', { src: u })); } });
      const grid = (rows) => el('div', { class: 'prop-grid' }, rows.filter(Boolean).flatMap((r) => (r === '-' ? [el('div', { class: 'prop-sep' })] : [el('span', { class: 'pk', text: r[0] }), r[1] instanceof Node ? r[1] : el('span', { class: 'pv-val', text: r[1], title: r[1] })])));
      const general = el('div', { class: 'prop-tab' },
        el('div', { class: 'prop-head' }, iconBox, nameInput),
        el('div', { class: 'prop-sep' }),
        grid([
          ['Type of file:', vol ? 'Local Disk' : typeName(e) + (e.ext && !e.isDir ? ` (.${e.ext})` : '')],
          ['Location:', P.dirname(e.path)],
          vol ? ['Used space:', `${fmtSize(vol.total - vol.free)}`] : ['Size:', sizeV],
          vol ? ['Free space:', `${fmtSize(vol.free)}`] : ['Size on disk:', diskV],
          vol ? ['Capacity:', `${fmtSize(vol.total)}`] : null,
          e.isDir && !vol ? ['Contains:', containsV] : null,
          '-',
          ['Created:', fmtDateLong(e.btime)],
          ['Modified:', fmtDateLong(e.mtime)],
          ['Accessed:', fmtDateLong(e.atime)],
          '-',
          ['Attributes:', el('span', { class: 'attrs' }, el('label', {}, ro, ' Read-only'), el('label', {}, hid, ' Hidden'))],
        ]));
      if (vol) {
        const used = vol.total ? (vol.total - vol.free) / vol.total : 0;
        general.append(el('div', { class: 'pie', style: { background: `conic-gradient(#0078d4 0 ${used * 360}deg, #9fd2ff ${used * 360}deg 360deg)` } }));
      }
      const security = el('div', { class: 'prop-tab', style: { display: 'none' } },
        grid([
          ['Object name:', e.path],
          ['Permissions:', U.modeString(e.mode, e.isDir)],
          ['Octal:', (e.mode & 0o7777).toString(8).padStart(4, '0')],
        ]),
        el('table', { class: 'perm-table' },
          el('tr', {}, el('th', { text: 'Group or user' }), el('th', { text: 'Read' }), el('th', { text: 'Write' }), el('th', { text: 'Execute' })),
          ...[['Owner', 6], ['Group', 3], ['Everyone', 0]].map(([n, sh]) => el('tr', {}, el('td', { text: n }), ...[4, 2, 1].map((b) => el('td', { text: (e.mode >> sh) & b ? '✓' : '' }))))),
        isMac ? el('button', { class: 'btn', text: 'Advanced (Get Info in Finder)…', onclick: () => api.getInfo(e.path) }) : null);
      const detailsTab = el('div', { class: 'prop-tab', style: { display: 'none' } });
      const tabs = el('div', { class: 'prop-tabs' });
      [['General', general], ['Security', security], ['Details', detailsTab]].forEach(([label, pane], i) => {
        tabs.append(el('button', {
          class: 'prop-tabbtn' + (i === 0 ? ' active' : ''), text: label,
          onclick: (ev) => { $$('.prop-tabbtn', tabs).forEach((b) => b.classList.remove('active')); ev.currentTarget.classList.add('active'); [general, security, detailsTab].forEach((p) => (p.style.display = p === pane ? '' : 'none')); },
        }));
      });
      const body = el('div', {}, tabs, general, security, detailsTab);
      (async () => {
        const rows = [['Name', e.name], ['Item type', typeName(e)], ['Folder path', P.dirname(e.path)], ['Date created', fmtDate(e.btime)], ['Date modified', fmtDate(e.mtime)], ['Size', e.isDir ? '' : fmtSize(e.size)], ['Attributes', ro.checked ? 'R' : 'A'], ['Owner', info.user]];
        if (kindOf(e.ext) === 'image') { const d = await api.imageSize(e.path); if (d) rows.push(['Dimensions', `${d.width} x ${d.height}`], ['Width', `${d.width} pixels`], ['Height', `${d.height} pixels`]); }
        detailsTab.append(grid(rows));
      })();
      if (!vol) {
        api.folderStats([e.path]).then((s) => {
          if (e.isDir && !e.isPackage) sizeV.textContent = `${fmtSize(s.bytes)} (${s.bytes.toLocaleString()} bytes)${s.partial ? '+' : ''}`;
          diskV.textContent = `${fmtSize(s.onDisk)} (${s.onDisk.toLocaleString()} bytes)`;
          containsV.textContent = `${plural(s.files, 'File')}, ${plural(Math.max(0, s.folders - 1), 'Folder')}`;
        });
      }
      const apply = async () => {
        let p = e.path;
        const newName = nameInput.value.trim();
        if (!nameInput.disabled && newName && newName !== e.name) {
          try { p = await api.rename(e.path, newName); pushUndo({ type: 'rename', label: 'Rename', from: e.path, to: p }); } catch (err) { await alertBox('Rename', err.message, 'error'); return false; }
        }
        try {
          const patch = {};
          if (ro.checked !== !(e.mode & 0o200)) patch.readOnly = ro.checked;
          if (!hid.disabled && hid.checked !== hiddenFlag) patch.hidden = hid.checked;
          if (Object.keys(patch).length) await api.setAttrs(p, patch);
        } catch (err) { await alertBox('Properties', err.message, 'error'); return false; }
        reload();
        return true;
      };
      await modal({
        title: `${e.path === '/' ? 'Macintosh HD' : e.name} Properties`, width: 440, body, className: 'props',
        buttons: [{ label: 'OK', primary: true, value: true, validate: apply }, { label: 'Cancel', value: false }, { label: 'Apply', value: null, validate: async () => { await apply(); return false; } }],
      });
      return;
    }
    // multiple
    const ents = (await Promise.all(paths.map(statSafe))).filter(Boolean);
    const files = ents.filter((e) => !e.isDir).length, folders = ents.length - files;
    const sizeV = el('span', { text: 'Calculating…' }), diskV = el('span', { text: 'Calculating…' });
    const sameDir = ents.every((e) => P.dirname(e.path) === P.dirname(ents[0].path));
    const types = new Set(ents.map(typeName));
    const body = el('div', { class: 'prop-tab' },
      el('div', { class: 'prop-head' }, el('span', { class: 'prop-icon', html: Icons.genericFileSvg('', 40) }), el('span', { text: `${plural(files, 'File')}, ${plural(folders, 'Folder')}` })),
      el('div', { class: 'prop-sep' }),
      el('div', { class: 'prop-grid' },
        el('span', { class: 'pk', text: 'Type:' }), el('span', { text: types.size === 1 ? `All of type ${[...types][0]}` : 'Multiple Types' }),
        el('span', { class: 'pk', text: 'Location:' }), el('span', { text: sameDir ? `All in ${P.dirname(ents[0].path)}` : 'Multiple locations' }),
        el('span', { class: 'pk', text: 'Size:' }), sizeV,
        el('span', { class: 'pk', text: 'Size on disk:' }), diskV));
    api.folderStats(paths).then((s) => { sizeV.textContent = `${fmtSize(s.bytes)} (${s.bytes.toLocaleString()} bytes)`; diskV.textContent = `${fmtSize(s.onDisk)} (${s.onDisk.toLocaleString()} bytes)`; });
    modal({ title: 'Properties', body, width: 420, buttons: [{ label: 'OK', primary: true, value: true }] });
  }

  async function showOptions() {
    const chk = (key, label, invert = false) => {
      const i = el('input', { type: 'checkbox', 'data-key': key, 'data-invert': invert ? '1' : '', checked: invert ? !settings[key] : !!settings[key] });
      return el('label', { class: 'opt' }, i, ' ' + label);
    };
    const start = el('select', { 'data-key': 'startPage' }, el('option', { value: 'home', text: 'Home' }), el('option', { value: 'thispc', text: 'This PC' }));
    start.value = settings.startPage || 'home';
    const theme = el('select', { 'data-key': 'theme' }, el('option', { value: 'system', text: 'Use system setting' }), el('option', { value: 'light', text: 'Light' }), el('option', { value: 'dark', text: 'Dark' }));
    theme.value = settings.theme || 'system';
    const body = el('div', { class: 'options' },
      el('h4', { text: 'General' }),
      el('div', { class: 'opt-row' }, el('span', { text: 'Open File Explorer to:' }), start),
      el('div', { class: 'opt-row' }, el('span', { text: 'Theme:' }), theme),
      el('div', { class: 'opt-group' }, el('div', { class: 'opt-label', text: 'Browse folders' }),
        el('label', { class: 'opt' }, el('input', { type: 'radio', name: 'browse', value: 'same', checked: !settings.openFoldersInNewTab }), ' Open each folder in the same tab'),
        el('label', { class: 'opt' }, el('input', { type: 'radio', name: 'browse', value: 'tab', checked: !!settings.openFoldersInNewTab }), ' Open each folder in its own tab')),
      el('h4', { text: 'Privacy' }),
      chk('showRecent', 'Show recently used files'),
      el('div', { class: 'opt-row' }, el('span', { text: 'Clear File Explorer history' }), el('button', { class: 'btn', text: 'Clear', onclick: () => { saveSettings({ recent: [] }); toast('History cleared'); if (curLoc() === HOME) reload(); } })),
      el('h4', { text: 'View' }),
      chk('showHidden', 'Show hidden files, folders, and drives'),
      chk('hideExtensions', 'Hide extensions for known file types'),
      chk('itemCheckboxes', 'Use check boxes to select items'),
      chk('compact', 'Decrease space between items (compact view)'),
      el('div', { class: 'opt-row' }, el('span', { text: 'Folder views' }), el('button', { class: 'btn', text: 'Reset Folders', onclick: () => { saveSettings({ folderViews: {} }); applyView(); toast('Folder views reset'); } })));
    const res = await modal({
      title: 'Folder Options', body, width: 460,
      buttons: [{ label: 'OK', primary: true, value: (c) => c }, { label: 'Cancel', value: null }],
    });
    if (!res) return;
    const patch = {};
    for (const i of $$('input[type=checkbox][data-key]', res)) patch[i.dataset.key] = i.dataset.invert ? !i.checked : i.checked;
    patch.startPage = start.value;
    patch.theme = theme.value;
    patch.openFoldersInNewTab = $('input[name=browse]:checked', res).value === 'tab';
    await saveSettings(patch);
    applyTheme();
    document.body.classList.toggle('compact', !!settings.compact);
    applyView();
    renderNav();
  }

  function showShortcuts() {
    const rows = [
      ['Open selected item', 'Enter'], ['Open in new tab', `${CMD}Enter / middle-click`], ['Back / Forward', `${CMD}[  ${CMD}]  or Alt+← / Alt+→`], ['Up one level', `${CMD}↑ or Alt+↑`],
      ['New window / New tab', `${CMD}N / ${CMD}T`], ['Close tab', `${CMD}W`], ['Switch tab', `Ctrl+Tab, ${CMD}1…9`], ['New folder', `${CMD}⇧N`],
      ['Rename', 'F2 (Tab to rename next)'], ['Delete (to Recycle Bin)', `Delete or ${CMD}⌫`], ['Permanently delete', `⇧Delete or ${CMD}⌥⌫`],
      ['Cut / Copy / Paste', `${CMD}X / ${CMD}C / ${CMD}V`], ['Undo / Redo', `${CMD}Z / ${CMD}⇧Z`], ['Select all', `${CMD}A`], ['Copy path', `${CMD}⇧C`],
      ['Properties', `Alt+Enter or ${CMD}I`], ['Preview pane / Details pane', 'Alt+P / Alt+⇧P'], ['Quick preview (peek)', 'Space'],
      ['Search', `${CMD}F, ${CMD}E or F3`], ['Edit address', `${CMD}L, Alt+D or F4`], ['Refresh', `F5 or ${CMD}R`], ['Show hidden items', `${CMD}⇧.`],
      ['Change view', `${CMD}⇧1…8 or ${CMD}+scroll`], ['Context menu', 'Right-click, ⇧F10'], ['Copy while dragging', 'Hold ⌥ Option'],
    ];
    modal({ title: 'Keyboard shortcuts', width: 520, body: el('div', { class: 'shortcuts' }, rows.flatMap(([a, b]) => [el('span', { text: a }), el('kbd', { text: b })])) });
  }

  /* ================================================================== */
  /* Layout: splitters, panes                                            */
  /* ================================================================== */
  function layoutPanes() {
    const nav = $('#navpane'), sp = $('#sidepane');
    nav.style.width = settings.navWidth + 'px';
    nav.style.display = state.navHidden ? 'none' : '';
    $('#split-nav').style.display = state.navHidden ? 'none' : '';
    const showPane = settings.pane !== 'none';
    sp.style.display = showPane ? '' : 'none';
    $('#split-pane').style.display = showPane ? '' : 'none';
    sp.style.width = settings.paneWidth + 'px';
    if (content.classList.contains('view-list')) layoutList();
  }
  function splitter(id, key, sign, min, max) {
    $(id).addEventListener('mousedown', (e) => {
      e.preventDefault();
      const start = e.clientX, w = settings[key];
      document.body.classList.add('resizing');
      const mv = (ev) => { settings[key] = Math.max(min, Math.min(max, w + (ev.clientX - start) * sign)); layoutPanes(); };
      const up = () => { document.body.classList.remove('resizing'); removeEventListener('mousemove', mv); removeEventListener('mouseup', up); saveSettings({ [key]: settings[key] }); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
  }
  splitter('#split-nav', 'navWidth', 1, 140, 480);
  splitter('#split-pane', 'paneWidth', -1, 200, 700);

  /* ================================================================== */
  /* Chrome buttons & menu actions                                       */
  /* ================================================================== */
  $('#btn-back').innerHTML = Icons.back;
  $('#btn-forward').innerHTML = Icons.forward;
  $('#btn-up').innerHTML = Icons.up;
  $('#btn-refresh').innerHTML = Icons.refresh;
  $('#tab-add').innerHTML = Icons.plus;
  $('.search-icon').innerHTML = Icons.search;
  $('#search-clear').innerHTML = Icons.close;
  $('#btn-back').addEventListener('click', goBack);
  $('#btn-forward').addEventListener('click', goForward);
  $('#btn-up').addEventListener('click', goUp);
  $('#btn-refresh').addEventListener('click', () => { reload(); refreshTree(); });
  $('#tab-add').addEventListener('click', () => addTab());
  // history dropdown on right-click of back/forward (Windows)
  for (const [id, dir] of [['#btn-back', -1], ['#btn-forward', 1]]) {
    $(id).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const t = tab();
      const items = [];
      for (let i = t.hi + dir; i >= 0 && i < t.history.length; i += dir) {
        const idx = i;
        items.push({ label: locName(t.history[i]), icon: locIconHtml(t.history[i], 16), action: () => { t.hi = idx; navigate(t.history[idx], { push: false }); } });
      }
      if (items.length) showMenu(items.slice(0, 15), { x: e.clientX, y: e.clientY });
    });
  }
  $('#titlebar').addEventListener('dblclick', (e) => { if (e.target.id === 'titlebar' || e.target.classList.contains('titlebar-fill') || e.target.id === 'tabs') api.toggleMax(); });
  // Mouse back/forward buttons
  window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } if (e.button === 4) { e.preventDefault(); goForward(); } });

  function inputFocused() { return document.activeElement && document.activeElement.matches('input, textarea'); }
  api.onMenu((action) => {
    if (!tab()) return;
    if (document.querySelector('.modal-back')) {
      if (action === 'selectAll' && inputFocused()) document.execCommand('selectAll');
      return;
    }
    if (action.startsWith('view:')) { setViewCfg({ view: action.slice(5) }); return; }
    if (action.startsWith('pane:')) { setPane(action.slice(5)); return; }
    if (action.startsWith('go:')) {
      const k = action.slice(3);
      navigate(k.startsWith('shell:') ? k : (k === 'trash' ? TRASH : info.paths[k]));
      return;
    }
    switch (action) {
      case 'newTab': addTab(undefined, true, state.active + 1); break;
      case 'newWindow': api.newWindow(isReal(curLoc()) ? curLoc() : undefined); break;
      case 'closeTab': closeTab(); break;
      case 'nextTab': activateTab((state.active + 1) % state.tabs.length); break;
      case 'prevTab': activateTab((state.active - 1 + state.tabs.length) % state.tabs.length); break;
      case 'newFolder': newFolder(); break;
      case 'newText': newFile('New Text Document.txt'); break;
      case 'open': if (selected().length) openPaths(selected()); break;
      case 'openNewTab': selected().forEach((p) => state.byPath.get(p)?.isDir && openInNewTab(p)); break;
      case 'terminal': if (isReal(curLoc())) api.terminal(selectedEntries().length === 1 && selectedEntries()[0].isDir ? selected()[0] : curLoc()); break;
      case 'properties': showProperties(selected().length ? selected() : [curLoc()]); break;
      case 'rename': renameSelected(); break;
      case 'compress': compressSelected(); break;
      case 'delete': if (!inputFocused()) deleteSelected(false); break;
      case 'deletePermanent': if (!inputFocused()) deleteSelected(true); break;
      case 'emptyTrash': emptyTrash(); break;
      case 'undo': if (inputFocused()) document.execCommand('undo'); else undo(); break;
      case 'redo': if (inputFocused()) document.execCommand('redo'); else redo(); break;
      case 'pasteShortcut': pasteShortcut(); break;
      case 'copyPath': copyPath(); break;
      case 'selectAll': if (inputFocused()) document.execCommand('selectAll'); else selectAll(); break;
      case 'selectNone': selectNone(); break;
      case 'invertSelection': invertSelection(); break;
      case 'search': searchInput.focus(); searchInput.select(); break;
      case 'address': editAddress(); break;
      case 'toggleNav': toggleNav(); break;
      case 'toggleCompact': toggleSetting('compact'); break;
      case 'toggleHidden': toggleSetting('showHidden'); toast(settings.showHidden ? 'Showing hidden items' : 'Hiding hidden items'); break;
      case 'toggleExt': toggleSetting('hideExtensions'); break;
      case 'toggleCheckboxes': toggleSetting('itemCheckboxes'); break;
      case 'refresh': reload(); refreshTree(); break;
      case 'back': goBack(); break;
      case 'forward': goForward(); break;
      case 'up': goUp(); break;
      case 'options': showOptions(); break;
      case 'shortcuts': showShortcuts(); break;
      default: break;
    }
  });
  api.onSettings((s) => {
    const oldPins = JSON.stringify(settings.pins);
    settings = { ...settings, ...s };
    applyTheme();
    if (JSON.stringify(settings.pins) !== oldPins) renderNav();
    if (tab() && curLoc() === HOME) reload();
  });
  api.onFullscreen((fs) => document.body.classList.toggle('fullscreen', fs));
  window.addEventListener('resize', () => { if (tab()) renderAddress(); });

  /* ================================================================== */
  /* Theme                                                               */
  /* ================================================================== */
  const mq = matchMedia('(prefers-color-scheme: dark)');
  let systemDark = info.dark;
  function applyTheme() {
    const t = settings.theme || 'system';
    const dark = t === 'dark' || (t === 'system' && (systemDark || mq.matches));
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  mq.addEventListener('change', applyTheme);
  api.onTheme((d) => { systemDark = d; applyTheme(); });

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */
  applyTheme();
  document.body.classList.add('platform-' + api.platform);
  document.body.classList.toggle('compact', !!settings.compact);
  state.volumes = await api.volumes();
  const startParam = new URLSearchParams(location.search).get('start');
  let startLoc = settings.startPage === 'thispc' ? THISPC : HOME;
  if (startParam) {
    if (await api.isDir(startParam)) startLoc = startParam;
    else if (await api.exists(startParam)) { startLoc = P.dirname(startParam); }
  }
  state.tabs.push(makeTab(startLoc));
  if (startParam && startLoc !== startParam) { tab().sel.add(startParam); tab().focus = startParam; }
  layoutPanes();
  renderNav();
  renderTabs();
  await loadLocation({ revealFocus: true });
  content.focus();
})();
