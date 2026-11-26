'use strict';
/* Shared helpers: DOM, formatting, file types, menus, dialogs, toasts. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- Paths ---------------- */
  const P = {
    basename: (p) => { if (p === '/') return '/'; const s = p.replace(/\/+$/, ''); return s.slice(s.lastIndexOf('/') + 1); },
    dirname: (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); },
    join: (...a) => a.join('/').replace(/\/+/g, '/'),
    ext: (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; },
    stem: (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; },
    toUrl: (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/'),
    isVirtual: (p) => typeof p === 'string' && p.startsWith('shell:'),
  };

  /* ---------------- Formatting ---------------- */
  function fmtSize(bytes, digits = 2) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} bytes`;
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    const d = v >= 100 ? 0 : v >= 10 ? 1 : digits;
    return `${v.toFixed(d).replace(/\.0+$/, '')} ${u[i]}`;
  }
  /* Windows details view style: "12,345 KB" */
  function fmtSizeKB(bytes) {
    if (bytes == null) return '';
    return `${Math.max(bytes ? 1 : 0, Math.ceil(bytes / 1024)).toLocaleString()} KB`;
  }
  const nf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtDate = (ms) => (ms ? nf.format(new Date(ms)) : '');
  const nfLong = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const fmtDateLong = (ms) => (ms ? nfLong.format(new Date(ms)) : '');
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  function modeString(mode, isDir) {
    const r = (b, c) => (mode & b ? c : '-');
    return (isDir ? 'd' : '-') + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o40, 'r') + r(0o20, 'w') + r(0o10, 'x') + r(0o4, 'r') + r(0o2, 'w') + r(0o1, 'x');
  }

  /* ---------------- File types ---------------- */
  const KIND = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'ico', 'icns', 'svg', 'avif', 'raw', 'cr2', 'nef', 'dng', 'psd'],
    video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp'],
    audio: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'aiff', 'aif', 'wma', 'opus', 'alac'],
    archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'pkg'],
    code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'm', 'mm', 'swift', 'java', 'kt', 'cs', 'php', 'sh', 'zsh', 'bash', 'fish', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'sql', 'lua', 'pl', 'r', 'vue', 'svelte', 'dart', 'gradle', 'makefile', 'dockerfile', 'plist', 'env', 'gitignore', 'lock'],
    text: ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rtf', 'nfo', 'srt', 'vtt', 'tex'],
    pdf: ['pdf'],
  };
  const kindOf = (ext) => { for (const [k, list] of Object.entries(KIND)) if (list.includes(ext)) return k; return 'other'; };
  const TYPE_NAMES = {
    txt: 'Text Document', md: 'Markdown Source File', pdf: 'PDF Document', doc: 'Microsoft Word 97 - 2003 Document', docx: 'Microsoft Word Document',
    xls: 'Microsoft Excel 97-2003 Worksheet', xlsx: 'Microsoft Excel Worksheet', ppt: 'Microsoft PowerPoint 97-2003 Presentation', pptx: 'Microsoft PowerPoint Presentation',
    pages: 'Pages Document', numbers: 'Numbers Spreadsheet', key: 'Keynote Presentation',
    jpg: 'JPG File', jpeg: 'JPEG File', png: 'PNG File', gif: 'GIF File', bmp: 'BMP File', webp: 'WEBP File', heic: 'HEIC File', svg: 'SVG Document', tif: 'TIF File', tiff: 'TIFF File', ico: 'Icon', icns: 'Apple Icon Image', psd: 'Adobe Photoshop Image',
    mp3: 'MP3 File', wav: 'WAV File', m4a: 'MPEG-4 Audio', flac: 'FLAC File', aac: 'AAC File',
    mp4: 'MP4 File', mov: 'QuickTime Movie', mkv: 'MKV File', avi: 'AVI File', webm: 'WEBM File',
    zip: 'Compressed (zipped) Folder', rar: 'RAR Archive', '7z': '7Z Archive', gz: 'GZ Archive', tar: 'TAR Archive', dmg: 'Disk Image', iso: 'Disc Image File', pkg: 'Installer Package',
    app: 'Application', html: 'HTML Document', htm: 'HTML Document', css: 'Cascading Style Sheet Document', js: 'JavaScript File', ts: 'TypeScript File', json: 'JSON Source File',
    py: 'Python File', sh: 'Shell Script', csv: 'Microsoft Excel Comma Separated Values File', rtf: 'Rich Text Format', xml: 'XML Document', log: 'Text Document', exe: 'Application (Windows)',
    plist: 'Property List', swift: 'Swift Source', c: 'C Source', cpp: 'C++ Source', h: 'C Header', java: 'Java Source File', yml: 'YAML Document', yaml: 'YAML Document', ttf: 'TrueType font file', otf: 'OpenType font file', lnk: 'Shortcut',
  };
  function typeName(e) {
    if (e.isSymlink && !e.isDir && e.broken) return 'Shortcut (broken)';
    if (e.isPackage && e.ext === 'app') return 'Application';
    if (e.isPackage) return `${e.ext.toUpperCase()} Package`;
    if (e.isDir) return 'File folder';
    if (e.isSymlink) return 'Shortcut';
    if (!e.ext) return 'File';
    return TYPE_NAMES[e.ext] || `${e.ext.toUpperCase()} File`;
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  /* ---------------- Menus ---------------- */
  const menuLayer = () => document.getElementById('menu-layer');
  let openMenus = [];
  function closeMenus(level = 0) {
    while (openMenus.length > level) {
      const m = openMenus.pop();
      m.el.remove();
      m.onClose && m.onClose();
    }
  }
  /**
   * items: [{label, icon, shortcut, action, checked, radio, disabled, submenu:[...]|fn, separator, danger}]
   * opts: {x, y, iconBar: [{icon, title, action, disabled}], anchor: Element, onClose, level}
   */
  function showMenu(items, opts = {}) {
    const level = opts.level || 0;
    closeMenus(level);
    const m = el('div', { class: 'menu' + (opts.className ? ' ' + opts.className : ''), role: 'menu' });
    if (opts.iconBar && opts.iconBar.length) {
      const bar = el('div', { class: 'menu-iconbar' });
      for (const b of opts.iconBar) {
        bar.append(el('button', {
          class: 'icon-btn', title: b.title, disabled: b.disabled, html: b.icon,
          onclick: (ev) => { ev.stopPropagation(); closeMenus(0); b.action(); },
        }));
      }
      m.append(bar);
    }
    let subTimer = null;
    for (const it of items) {
      if (!it) continue;
      if (it.separator) { m.append(el('div', { class: 'menu-sep' })); continue; }
      if (it.header) { m.append(el('div', { class: 'menu-header', text: it.header })); continue; }
      const hasSub = !!it.submenu;
      const row = el('div', { class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : ''), role: 'menuitem', tabindex: -1 },
        el('span', { class: 'mi-check', html: it.checked ? (it.radio ? '<span class="dot"></span>' : Icons.check) : '' }),
        el('span', { class: 'mi-icon', html: it.icon || '' }),
        el('span', { class: 'mi-label', text: it.label }),
        el('span', { class: 'mi-shortcut', text: it.shortcut || '' }),
        el('span', { class: 'mi-arrow', html: hasSub ? Icons.chevronRight : '' }));
      if (!it.disabled) {
        const openSub = () => {
          const r = row.getBoundingClientRect();
          const sub = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
          Promise.resolve(sub).then((s) => {
            showMenu(s, { x: r.right - 4, y: r.top - 5, level: level + 1, flipX: r.left });
          });
        };
        row.addEventListener('mouseenter', () => {
          clearTimeout(subTimer);
          $$('.menu-item.sub-open', m).forEach((x) => x.classList.remove('sub-open'));
          if (hasSub) { row.classList.add('sub-open'); subTimer = setTimeout(openSub, 150); } else subTimer = setTimeout(() => closeMenus(level + 1), 150);
        });
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (hasSub) { clearTimeout(subTimer); openSub(); return; }
          closeMenus(0);
          it.action && it.action();
        });
      }
      m.append(row);
    }
    menuLayer().append(m);
    // position
    let x = opts.x, y = opts.y;
    if (opts.anchor) { const r = opts.anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
    const mw = m.offsetWidth, mh = m.offsetHeight, vw = innerWidth, vh = innerHeight;
    if (x + mw > vw - 4) x = opts.flipX != null ? Math.max(4, opts.flipX - mw + 4) : Math.max(4, vw - mw - 4);
    if (y + mh > vh - 4) y = Math.max(4, (opts.anchor && !opts.level ? opts.anchor.getBoundingClientRect().top - mh - 2 : vh - mh - 4));
    m.style.left = x + 'px'; m.style.top = y + 'px';
    requestAnimationFrame(() => m.classList.add('show'));
    openMenus.push({ el: m, onClose: opts.onClose });
    return m;
  }
  document.addEventListener('mousedown', (e) => { if (openMenus.length && !e.target.closest('.menu')) closeMenus(0); }, true);
  window.addEventListener('blur', () => closeMenus(0));
  window.addEventListener('resize', () => closeMenus(0));
  document.addEventListener('keydown', (e) => {
    if (!openMenus.length) return;
    const m = openMenus[openMenus.length - 1].el;
    const rows = $$('.menu-item:not(.disabled)', m);
    const cur = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(openMenus.length - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (rows[cur + 1] || rows[0])?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); (rows[cur - 1] || rows[rows.length - 1])?.focus(); }
    else if (e.key === 'ArrowRight' && cur >= 0) { e.preventDefault(); e.stopPropagation(); rows[cur].click(); setTimeout(() => { const n = openMenus[openMenus.length - 1]; if (n && n.el !== m) $('.menu-item:not(.disabled)', n.el)?.focus(); }, 0); }
    else if (e.key === 'ArrowLeft' && openMenus.length > 1) { e.preventDefault(); e.stopPropagation(); closeMenus(openMenus.length - 1); }
    else if (e.key === 'Enter' && cur >= 0) { e.preventDefault(); e.stopPropagation(); rows[cur].click(); }
    else { e.stopPropagation(); }
  }, true);

  /* ---------------- Modal dialogs ---------------- */
  function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width = 420, onOpen, className = '' }) {
    return new Promise((resolve) => {
      const layer = document.getElementById('modal-layer');
      const prevFocus = document.activeElement;
      const back = el('div', { class: 'modal-back' });
      const dlg = el('div', { class: 'modal ' + className, role: 'dialog', style: { width: width + 'px' } });
      const head = el('div', { class: 'modal-title' }, el('span', { text: title }),
        el('button', { class: 'icon-btn small modal-x', html: Icons.close, onclick: () => done(null) }));
      const content = el('div', { class: 'modal-body' });
      if (typeof body === 'string') content.innerHTML = body; else if (body) content.append(body);
      const foot = el('div', { class: 'modal-foot' });
      const done = (v) => {
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        prevFocus && prevFocus.focus && prevFocus.focus();
        resolve(v);
      };
      for (const b of buttons) {
        foot.append(el('button', {
          class: 'btn' + (b.primary ? ' primary' : ''),
          text: b.label,
          onclick: async () => {
            if (b.validate) { const ok = await b.validate(content); if (!ok) return; }
            done(typeof b.value === 'function' ? b.value(content) : b.value);
          },
        }));
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && !(e.target.tagName === 'TEXTAREA')) {
          const p = buttons.find((b) => b.primary);
          if (p) { e.preventDefault(); e.stopPropagation(); foot.querySelector('.btn.primary').click(); }
        } else e.stopPropagation();
      };
      document.addEventListener('keydown', onKey, true);
      dlg.append(head, content);
      if (buttons.length) dlg.append(foot);
      back.append(dlg);
      layer.append(back);
      // draggable by title
      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        const r = dlg.getBoundingClientRect();
        const ox = e.clientX - r.left, oy = e.clientY - r.top;
        dlg.style.position = 'fixed'; dlg.style.margin = 0;
        const mv = (ev) => { dlg.style.left = ev.clientX - ox + 'px'; dlg.style.top = ev.clientY - oy + 'px'; };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      });
      onOpen && onOpen(content, done);
      const f = content.querySelector('input,select,textarea') || foot.querySelector('.btn.primary');
      f && setTimeout(() => f.focus(), 0);
    });
  }
  const alertBox = (title, message, kind = 'info') => modal({
    title,
    body: el('div', { class: 'msg-row' }, el('span', { class: 'msg-icon ' + kind, html: kind === 'warning' || kind === 'error' ? Icons.warning : Icons.info }), el('div', { class: 'msg-text', text: message })),
  });
  const confirmBox = (title, message, yes = 'Yes', no = 'No', kind = 'warning') => modal({
    title,
    body: el('div', { class: 'msg-row' }, el('span', { class: 'msg-icon ' + kind, html: Icons.warning }), el('div', { class: 'msg-text', text: message })),
    buttons: [{ label: yes, value: true, primary: true }, { label: no, value: false }],
  });

  /* ---------------- Toasts ---------------- */
  function toast(text, ms = 2600) {
    const t = el('div', { class: 'toast', text });
    document.getElementById('toast-layer').append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  }

  window.U = { $, $$, el, esc, P, fmtSize, fmtSizeKB, fmtDate, fmtDateLong, plural, modeString, kindOf, KIND, typeName, collator, showMenu, closeMenus, modal, alertBox, confirmBox, toast };
})();
