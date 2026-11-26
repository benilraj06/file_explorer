'use strict';
/*
 * File Explorer for macOS — main process.
 * Exposes all filesystem / shell operations to the renderer over IPC.
 */
const { app, BrowserWindow, ipcMain, shell, nativeImage, clipboard, dialog, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile, spawn } = require('child_process');

const isMac = process.platform === 'darwin';
const HOME = os.homedir();

/* ------------------------------------------------------------------ */
/* Settings store                                                      */
/* ------------------------------------------------------------------ */
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  pins: null, // filled on first run
  recent: [],
  folderViews: {},
  defaultView: { view: 'details', sortKey: 'name', sortDir: 1, groupBy: 'none' },
  showHidden: false,
  hideExtensions: false,
  itemCheckboxes: false,
  pane: 'none', // none | preview | details
  navWidth: 240,
  paneWidth: 300,
  theme: 'system',
  compact: false,
  showRecent: true,
  colWidths: { name: 320, date: 170, type: 150, size: 100, folder: 280 },
  openFoldersInNewTab: false,
};
let settings = null;
function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (!Array.isArray(settings.pins)) {
    settings.pins = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos']
      .map((k) => safeGetPath(k)).filter(Boolean);
  }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
    } catch (e) { console.error('save settings', e); }
  }, 200);
}
function safeGetPath(name) {
  try { return app.getPath(name); } catch { return null; }
}
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}
const exists = async (p) => { try { await fsp.lstat(p); return true; } catch { return false; } };

function splitName(name, isDir) {
  if (isDir) return [name, ''];
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}
/** Windows style unique names: "New folder (2)", "file - Copy (2).txt" */
async function uniquePath(dir, name, isDir, copyStyle = false) {
  let target = path.join(dir, name);
  if (!(await exists(target))) return target;
  const [base, ext] = splitName(name, isDir);
  if (copyStyle) {
    target = path.join(dir, `${base} - Copy${ext}`);
    if (!(await exists(target))) return target;
    for (let i = 2; ; i++) {
      target = path.join(dir, `${base} - Copy (${i})${ext}`);
      if (!(await exists(target))) return target;
    }
  }
  for (let i = 2; ; i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(target))) return target;
  }
}

function entryFromStat(dir, name, st, lst) {
  const full = path.join(dir, name);
  const isDir = st ? st.isDirectory() : false;
  const ext = isDir ? '' : (path.extname(name).slice(1) || '').toLowerCase();
  const bundleExts = ['app', 'bundle', 'framework', 'plugin', 'kext', 'prefpane', 'photoslibrary', 'xcodeproj', 'xcworkspace', 'pkg', 'rtfd'];
  const pext = path.extname(name).slice(1).toLowerCase();
  return {
    name,
    path: full,
    isDir,
    isPackage: isDir && bundleExts.includes(pext),
    isSymlink: lst ? lst.isSymbolicLink() : false,
    broken: !st,
    size: st && !isDir ? st.size : 0,
    mtime: st ? st.mtimeMs : (lst ? lst.mtimeMs : 0),
    ctime: st ? st.ctimeMs : 0,
    btime: st ? (st.birthtimeMs || st.ctimeMs) : 0,
    atime: st ? st.atimeMs : 0,
    ext: pext && !isDir ? ext : (isDir && bundleExts.includes(pext) ? pext : ''),
    hidden: name.startsWith('.'),
    mode: st ? st.mode : 0,
  };
}

async function statEntry(dir, name) {
  const full = path.join(dir, name);
  let lst = null, st = null;
  try { lst = await fsp.lstat(full); } catch { return null; }
  if (lst.isSymbolicLink()) { try { st = await fsp.stat(full); } catch { st = null; } } else st = lst;
  return entryFromStat(dir, name, st, lst);
}

/* macOS "hidden" flag (UF_HIDDEN) — we treat it as hidden too */
async function hiddenFlagged(dir) {
  if (!isMac) return new Set();
  try {
    const out = await run('/bin/ls', ['-1aO', dir]);
    const set = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(.*)$/);
      if (m && m[1].split(',').includes('hidden')) set.add(m[2]);
    }
    return set;
  } catch { return new Set(); }
}

/* ------------------------------------------------------------------ */
/* Directory listing & watching                                        */
/* ------------------------------------------------------------------ */
ipcMain.handle('fs:readDir', async (_e, dir) => {
  const names = await fsp.readdir(dir);
  const flagged = await hiddenFlagged(dir);
  const out = [];
  const CHUNK = 256;
  for (let i = 0; i < names.length; i += CHUNK) {
    const part = await Promise.all(names.slice(i, i + CHUNK).map((n) => statEntry(dir, n)));
    for (const e of part) if (e) { if (flagged.has(e.name)) e.hidden = true; out.push(e); }
  }
  return out;
});

ipcMain.handle('fs:stat', async (_e, p) => {
  const e = await statEntry(path.dirname(p), path.basename(p));
  if (!e) throw new Error('Not found: ' + p);
  if (p === '/') e.name = 'Macintosh HD';
  return e;
});

ipcMain.handle('fs:exists', (_e, p) => exists(p));
ipcMain.handle('fs:isDir', async (_e, p) => { try { return (await fsp.stat(p)).isDirectory(); } catch { return false; } });

ipcMain.handle('fs:subdirs', async (_e, dir, showHidden) => {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const res = [];
    for (const d of ents) {
      if (!showHidden && d.name.startsWith('.')) continue;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) { try { isDir = (await fsp.stat(path.join(dir, d.name))).isDirectory(); } catch { isDir = false; } }
      if (isDir && !/\.(app|bundle|framework|photoslibrary)$/i.test(d.name)) res.push({ name: d.name, path: path.join(dir, d.name) });
    }
    res.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return res;
  } catch { return []; }
});

const watchers = new Map(); // webContents.id -> Map(dir -> watcher)
ipcMain.handle('fs:watch', (e, dirs) => {
  const id = e.sender.id;
  let map = watchers.get(id);
  if (!map) {
    map = new Map(); watchers.set(id, map);
    e.sender.once('destroyed', () => { for (const w of map.values()) w.close(); watchers.delete(id); });
  }
  const want = new Set(dirs);
  for (const [d, w] of map) if (!want.has(d)) { w.close(); map.delete(d); }
  for (const d of want) {
    if (map.has(d)) continue;
    try {
      let t = null;
      const w = fs.watch(d, { persistent: false }, () => {
        clearTimeout(t);
        t = setTimeout(() => { if (!e.sender.isDestroyed()) e.sender.send('fs:changed', d); }, 250);
      });
      w.on('error', () => { try { w.close(); } catch {} map.delete(d); });
      map.set(d, w);
    } catch { /* not watchable */ }
  }
  return true;
});

/* ------------------------------------------------------------------ */
/* Special folders, volumes                                            */
/* ------------------------------------------------------------------ */
ipcMain.handle('sys:info', () => ({
  home: HOME,
  user: os.userInfo().username,
  platform: process.platform,
  sep: path.sep,
  paths: {
    home: HOME,
    desktop: safeGetPath('desktop'),
    documents: safeGetPath('documents'),
    downloads: safeGetPath('downloads'),
    pictures: safeGetPath('pictures'),
    music: safeGetPath('music'),
    videos: safeGetPath('videos'),
    applications: isMac ? '/Applications' : '/usr/share/applications',
    trash: isMac ? path.join(HOME, '.Trash') : path.join(HOME, '.local/share/Trash/files'),
    root: '/',
  },
  dark: nativeTheme.shouldUseDarkColors,
}));

async function volumeInfo(p, name) {
  try {
    const s = await fsp.statfs(p);
    return { name, path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return { name, path: p, total: 0, free: 0 }; }
}
ipcMain.handle('sys:volumes', async () => {
  const vols = [];
  const rootName = isMac ? 'Macintosh HD' : 'Local Disk';
  vols.push({ ...(await volumeInfo('/', rootName)), root: true });
  if (isMac) {
    let rootDev = null;
    try { rootDev = (await fsp.stat('/')).dev; } catch {}
    try {
      for (const n of await fsp.readdir('/Volumes')) {
        const p = path.join('/Volumes', n);
        try {
          const st = await fsp.stat(p);
          if (st.dev === rootDev) continue; // symlink to root volume
          vols.push({ ...(await volumeInfo(p, n)), removable: true });
        } catch {}
      }
    } catch {}
  } else {
    for (const base of ['/media', '/mnt']) {
      try { for (const n of await fsp.readdir(base)) vols.push(await volumeInfo(path.join(base, n), n)); } catch {}
    }
  }
  return vols;
});

ipcMain.handle('sys:eject', async (_e, p) => {
  if (isMac) await run('/usr/sbin/diskutil', ['eject', p]);
  return true;
});

/* ------------------------------------------------------------------ */
/* Icons, thumbnails, previews                                         */
/* ------------------------------------------------------------------ */
const iconCache = new Map();
ipcMain.handle('fs:icon', async (_e, p, size = 'normal', key) => {
  const k = (key || p) + '|' + size;
  if (iconCache.has(k)) return iconCache.get(k);
  try {
    const img = await app.getFileIcon(p, { size });
    const url = img.isEmpty() ? null : img.toDataURL();
    iconCache.set(k, url);
    return url;
  } catch { iconCache.set(k, null); return null; }
});

ipcMain.handle('fs:thumb', async (_e, p, size = 256) => {
  try {
    if (nativeImage.createThumbnailFromPath && isMac) {
      const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
      if (!img.isEmpty()) return img.toDataURL();
    }
  } catch {}
  try {
    const st = await fsp.stat(p);
    if (st.size < 40 * 1024 * 1024) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        const s = img.getSize();
        const r = Math.min(1, size / Math.max(s.width, s.height));
        return img.resize({ width: Math.max(1, Math.round(s.width * r)), height: Math.max(1, Math.round(s.height * r)), quality: 'good' }).toDataURL();
      }
    }
  } catch {}
  return null;
});

ipcMain.handle('fs:imageSize', async (_e, p) => {
  try { const img = nativeImage.createFromPath(p); return img.isEmpty() ? null : img.getSize(); } catch { return null; }
});

ipcMain.handle('fs:readText', async (_e, p, max = 256 * 1024) => {
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    const slice = buf.subarray(0, bytesRead);
    // binary sniff
    let bin = 0;
    for (let i = 0; i < Math.min(slice.length, 8000); i++) if (slice[i] === 0) { bin++; break; }
    return { text: bin ? null : slice.toString('utf8'), truncated: bytesRead === max };
  } finally { await fh.close(); }
});

/* ------------------------------------------------------------------ */
/* File operations                                                     */
/* ------------------------------------------------------------------ */
ipcMain.handle('fs:mkdir', async (_e, dir, name = 'New folder') => {
  const target = await uniquePath(dir, name, true);
  await fsp.mkdir(target);
  return target;
});

ipcMain.handle('fs:newFile', async (_e, dir, name, content = '') => {
  const target = await uniquePath(dir, name, false);
  await fsp.writeFile(target, content, { flag: 'wx' });
  return target;
});

ipcMain.handle('fs:rename', async (_e, from, newName) => {
  if (!newName || /[/\0]/.test(newName)) throw new Error('A file name can\'t contain the character /');
  const to = path.join(path.dirname(from), newName);
  if (to === from) return to;
  if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) {
    throw new Error(`There is already a file with the same name "${newName}" in this location.`);
  }
  await fsp.rename(from, to);
  return to;
});

ipcMain.handle('fs:symlink', async (_e, sources, destDir) => {
  const out = [];
  for (const s of sources) {
    const t = await uniquePath(destDir, path.basename(s) + ' - Shortcut', false);
    await fsp.symlink(s, t);
    out.push(t);
  }
  return out;
});

ipcMain.handle('fs:conflicts', async (_e, sources, destDir) => {
  const res = [];
  for (const s of sources) {
    if (path.dirname(s) === destDir) continue;
    const t = path.join(destDir, path.basename(s));
    if (await exists(t)) res.push({ source: s, target: t });
  }
  return res;
});

/* Copy / move engine with progress reporting */
const activeOps = new Map();
let opSeq = 0;

async function measure(p, acc, cancel) {
  if (cancel.cancelled) return;
  let st;
  try { st = await fsp.lstat(p); } catch { return; }
  if (st.isDirectory()) {
    acc.files++;
    let names = [];
    try { names = await fsp.readdir(p); } catch {}
    for (const n of names) await measure(path.join(p, n), acc, cancel);
  } else { acc.files++; acc.bytes += st.size; }
}

async function copyRecursive(src, dst, op) {
  if (op.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dst);
    op.doneFiles++;
  } else if (st.isDirectory()) {
    await fsp.mkdir(dst, { recursive: true });
    op.doneFiles++;
    for (const n of await fsp.readdir(src)) await copyRecursive(path.join(src, n), path.join(dst, n), op);
    try { await fsp.utimes(dst, st.atime, st.mtime); await fsp.chmod(dst, st.mode); } catch {}
  } else {
    op.current = path.basename(src);
    await fsp.copyFile(src, dst, fs.constants.COPYFILE_FICLONE);
    try { await fsp.utimes(dst, st.atime, st.mtime); } catch {}
    op.doneFiles++; op.doneBytes += st.size;
  }
  op.tick();
}

ipcMain.handle('fs:transfer', async (e, { sources, destDir, mode, policy = 'keepboth' }) => {
  const id = ++opSeq;
  const op = {
    id, cancelled: false, doneBytes: 0, doneFiles: 0, totalBytes: 0, totalFiles: 0, current: '',
    last: 0,
    tick() {
      const now = Date.now();
      if (now - this.last < 100) return;
      this.last = now;
      if (!e.sender.isDestroyed()) e.sender.send('op:progress', { id, mode, doneBytes: this.doneBytes, totalBytes: this.totalBytes, doneFiles: this.doneFiles, totalFiles: this.totalFiles, current: this.current, dest: destDir });
    },
  };
  activeOps.set(id, op);
  e.sender.send('op:start', { id, mode, count: sources.length, dest: destDir });
  const results = []; // {from, to}
  const errors = [];
  if (mode === 'auto') {
    try {
      const [a, b] = await Promise.all([fsp.stat(sources[0]), fsp.stat(destDir)]);
      mode = a.dev === b.dev ? 'move' : 'copy';
    } catch { mode = 'copy'; }
  }
  try {
    const acc = { files: 0, bytes: 0 };
    let destDev = null;
    try { destDev = (await fsp.stat(destDir)).dev; } catch {}
    const needCopy = [];
    for (const s of sources) {
      let sst; try { sst = await fsp.lstat(s); } catch { errors.push(`${s}: not found`); continue; }
      if (mode === 'move' && sst.dev === destDev) continue;
      needCopy.push(s);
    }
    for (const s of needCopy) await measure(s, acc, op);
    op.totalBytes = acc.bytes; op.totalFiles = acc.files;

    for (const src of sources) {
      if (op.cancelled) break;
      const name = path.basename(src);
      let target = path.join(destDir, name);
      let sst; try { sst = await fsp.lstat(src); } catch { continue; }
      const isDir = sst.isDirectory();
      if ((destDir + path.sep).startsWith(src + path.sep)) {
        errors.push(`The destination folder is a subfolder of the source folder: ${name}`);
        continue;
      }
      if (mode === 'move' && path.dirname(src) === destDir) continue;
      if (await exists(target)) {
        if (path.dirname(src) === destDir) target = await uniquePath(destDir, name, isDir, true);
        else if (policy === 'skip') continue;
        else if (policy === 'keepboth') target = await uniquePath(destDir, name, isDir);
        else if (policy === 'replace') {
          try { await shell.trashItem(target); } catch { await fsp.rm(target, { recursive: true, force: true }); }
        }
      }
      try {
        if (mode === 'move') {
          try {
            await fsp.rename(src, target);
          } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            await copyRecursive(src, target, op);
            await fsp.rm(src, { recursive: true, force: true });
          }
        } else {
          await copyRecursive(src, target, op);
        }
        results.push({ from: src, to: target });
      } catch (err) {
        if (err.cancelled) break;
        errors.push(`${name}: ${err.message}`);
      }
    }
  } finally {
    activeOps.delete(id);
    if (!e.sender.isDestroyed()) e.sender.send('op:end', { id });
  }
  return { results, errors, cancelled: op.cancelled, mode };
});

ipcMain.handle('op:cancel', (_e, id) => { const op = activeOps.get(id); if (op) op.cancelled = true; return true; });

ipcMain.handle('fs:trash', async (_e, paths) => {
  const errors = [];
  const restore = []; // {from: path in trash, to: original path} — best effort, used for Undo
  const trashDir = isMac ? path.join(HOME, '.Trash') : path.join(HOME, '.local/share/Trash/files');
  let before = null;
  try { before = new Set(await fsp.readdir(trashDir)); } catch { before = null; }
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      if (before) {
        try {
          const now = await fsp.readdir(trashDir);
          const added = now.filter((n) => !before.has(n));
          const base = path.basename(p);
          const [stem] = splitName(base, false);
          const hit = added.find((n) => n === base) || added.find((n) => n.startsWith(stem));
          if (hit) { restore.push({ from: path.join(trashDir, hit), to: p }); before.add(hit); }
        } catch {}
      }
    } catch (err) { errors.push(`${path.basename(p)}: ${err.message}`); }
  }
  return { errors, restore };
});

ipcMain.handle('fs:movePairs', async (_e, pairs) => {
  const errors = [];
  for (const { from, to } of pairs) {
    try {
      if (await exists(to)) throw new Error(`"${path.basename(to)}" already exists`);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      try { await fsp.rename(from, to); } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        await fsp.rm(from, { recursive: true, force: true });
      }
    } catch (err) { errors.push(`${path.basename(from)}: ${err.message}`); }
  }
  return { errors };
});

ipcMain.handle('fs:delete', async (_e, paths) => {
  const errors = [];
  for (const p of paths) {
    try { await fsp.rm(p, { recursive: true, force: true }); } catch (err) { errors.push(`${path.basename(p)}: ${err.message}`); }
  }
  return { errors };
});

ipcMain.handle('fs:emptyTrash', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Yes', 'No'], defaultId: 1, cancelId: 1,
    message: 'Are you sure you want to permanently delete all of the items in the Recycle Bin?',
    detail: 'You can\'t undo this action.',
  });
  if (r.response !== 0) return false;
  if (isMac) {
    try { await run('/usr/bin/osascript', ['-e', 'tell application "Finder" to empty trash']); return true; } catch {}
  }
  const trash = isMac ? path.join(HOME, '.Trash') : path.join(HOME, '.local/share/Trash/files');
  for (const n of await fsp.readdir(trash)) await fsp.rm(path.join(trash, n), { recursive: true, force: true });
  return true;
});

ipcMain.handle('fs:folderStats', async (_e, paths) => {
  const acc = { files: 0, folders: 0, bytes: 0, onDisk: 0 };
  const deadline = Date.now() + 15000;
  async function walk(p) {
    if (Date.now() > deadline) { acc.partial = true; return; }
    let st; try { st = await fsp.lstat(p); } catch { return; }
    acc.onDisk += (st.blocks || 0) * 512;
    if (st.isDirectory()) {
      acc.folders++;
      let names = []; try { names = await fsp.readdir(p); } catch {}
      for (const n of names) await walk(path.join(p, n));
    } else { acc.files++; acc.bytes += st.size; }
  }
  for (const p of paths) await walk(p);
  return acc;
});

ipcMain.handle('fs:setAttrs', async (_e, p, { readOnly, hidden }) => {
  const st = await fsp.stat(p);
  if (readOnly !== undefined) {
    const mode = readOnly ? (st.mode & ~0o222) : (st.mode | 0o200);
    await fsp.chmod(p, mode & 0o7777);
  }
  if (hidden !== undefined && isMac) await run('/usr/bin/chflags', [hidden ? 'hidden' : 'nohidden', p]);
  return true;
});

ipcMain.handle('fs:isHiddenFlag', async (_e, p) => (await hiddenFlagged(path.dirname(p))).has(path.basename(p)));

/* Compress / extract */
ipcMain.handle('fs:compress', async (_e, paths) => {
  const dir = path.dirname(paths[0]);
  const base = paths.length === 1 ? splitName(path.basename(paths[0]), false)[0] || path.basename(paths[0]) : path.basename(paths[0], path.extname(paths[0]));
  const target = await uniquePath(dir, `${base}.zip`, false);
  if (isMac && paths.length === 1) {
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', paths[0], target]);
  } else {
    await run('zip', ['-r', '-y', '-q', target, ...paths.map((p) => path.basename(p))], { cwd: dir });
  }
  return target;
});

ipcMain.handle('fs:extract', async (_e, archive, destDir) => {
  const base = splitName(path.basename(archive), false)[0];
  const target = destDir || (await uniquePath(path.dirname(archive), base, true));
  await fsp.mkdir(target, { recursive: true });
  const ext = path.extname(archive).toLowerCase();
  if (ext === '.zip') {
    if (isMac) await run('/usr/bin/ditto', ['-x', '-k', archive, target]);
    else await run('unzip', ['-q', '-o', archive, '-d', target]);
  } else {
    await run('tar', ['-xf', archive, '-C', target]);
  }
  // Flatten a single top-level folder with the same name ("archive/archive/...")
  try {
    const items = (await fsp.readdir(target)).filter((n) => n !== '__MACOSX');
    if (items.length === 1 && items[0] === path.basename(target)) {
      const inner = path.join(target, items[0]);
      if ((await fsp.stat(inner)).isDirectory()) {
        const tmp = target + '.__tmp__' + Date.now();
        await fsp.rename(inner, tmp);
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.rename(tmp, target);
      }
    }
    await fsp.rm(path.join(target, '__MACOSX'), { recursive: true, force: true });
  } catch {}
  return target;
});

/* ------------------------------------------------------------------ */
/* Search (streaming)                                                  */
/* ------------------------------------------------------------------ */
const searches = new Map();
function makeMatcher(q) {
  q = q.trim();
  if (/[*?]/.test(q)) {
    const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (n) => re.test(n);
  }
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (n) => { const l = n.toLowerCase(); return terms.every((t) => l.includes(t)); };
}
ipcMain.handle('search:start', async (e, { id, root, query, showHidden }) => {
  const state = { cancelled: false };
  searches.set(id, state);
  const match = makeMatcher(query);
  let batch = [];
  let count = 0;
  const flush = () => {
    if (batch.length && !e.sender.isDestroyed()) e.sender.send('search:results', { id, items: batch });
    batch = [];
  };
  let lastFlush = Date.now();
  const queue = [root];
  const skip = new Set(['node_modules', '.git', 'Library']);
  while (queue.length && !state.cancelled && count < 10000) {
    const dir = queue.shift();
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ents) {
      if (state.cancelled) break;
      if (!showHidden && d.name.startsWith('.')) continue;
      const full = path.join(dir, d.name);
      if (match(d.name)) {
        const ent = await statEntry(dir, d.name);
        if (ent) { batch.push(ent); count++; }
      }
      if (d.isDirectory() && !(skip.has(d.name) && dir !== root) && !/\.(app|photoslibrary|bundle|framework)$/i.test(d.name)) queue.push(full);
    }
    if (batch.length >= 100 || Date.now() - lastFlush > 300) { flush(); lastFlush = Date.now(); }
  }
  flush();
  searches.delete(id);
  if (!e.sender.isDestroyed()) e.sender.send('search:done', { id, cancelled: state.cancelled, count });
  return true;
});
ipcMain.handle('search:cancel', (_e, id) => { const s = searches.get(id); if (s) s.cancelled = true; return true; });

/* ------------------------------------------------------------------ */
/* Shell integration                                                   */
/* ------------------------------------------------------------------ */
function addRecent(p) {
  settings.recent = [p, ...settings.recent.filter((x) => x !== p)].slice(0, 40);
  saveSettings();
  broadcast('settings:changed', settings);
}
ipcMain.handle('shell:open', async (_e, p) => {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  addRecent(p);
  return true;
});
ipcMain.handle('shell:openWith', async (e, paths) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Open with', defaultPath: isMac ? '/Applications' : '/usr/bin',
    buttonLabel: 'Open', properties: ['openFile'],
    filters: isMac ? [{ name: 'Applications', extensions: ['app'] }] : [],
  });
  if (r.canceled || !r.filePaths.length) return false;
  const appPath = r.filePaths[0];
  if (isMac) await run('/usr/bin/open', ['-a', appPath, ...paths]);
  else spawn(appPath, paths, { detached: true, stdio: 'ignore' }).unref();
  paths.forEach(addRecent);
  return true;
});
ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:terminal', async (_e, dir) => {
  if (isMac) await run('/usr/bin/open', ['-a', 'Terminal', dir]);
  else spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
  return true;
});
ipcMain.handle('shell:openVSCode', async (_e, p) => {
  if (isMac) await run('/usr/bin/open', ['-a', 'Visual Studio Code', p]);
  return true;
});
ipcMain.handle('shell:getInfo', async (_e, p) => {
  if (isMac) {
    const esc = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await run('/usr/bin/osascript', ['-e', `tell application "Finder" to open information window of (POSIX file "${esc}" as alias)`, '-e', 'tell application "Finder" to activate']);
  }
  return true;
});
ipcMain.handle('shell:share', async (e, paths) => {
  // Native share sheet (macOS): Electron ShareMenu
  if (!isMac) return false;
  const { ShareMenu } = require('electron');
  const menu = new ShareMenu({ filePaths: paths });
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
  return true;
});
ipcMain.handle('shell:privacy', async () => {
  if (isMac) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  return true;
});
ipcMain.handle('shell:beep', () => { shell.beep(); return true; });

/* Clipboard — interoperates with Finder */
ipcMain.handle('clip:writeFiles', (_e, paths) => {
  // Writes Finder-compatible file references so files copied here can be pasted in Finder (and vice versa).
  if (isMac) {
    const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><array>' +
      paths.map((p) => `<string>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('') + '</array></plist>';
    try { clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(plist, 'utf8')); return true; } catch {}
  }
  clipboard.writeText(paths.join('\n'));
  return true;
});
ipcMain.handle('clip:readFiles', () => {
  if (!isMac) return [];
  try {
    const buf = clipboard.readBuffer('NSFilenamesPboardType');
    if (buf && buf.length) {
      const xml = buf.toString('utf8');
      const out = [];
      xml.replace(/<string>([\s\S]*?)<\/string>/g, (_m, s) => { out.push(s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); });
      return out;
    }
    const url = clipboard.read('public.file-url');
    if (url && url.startsWith('file://')) return [require('url').fileURLToPath(url)];
  } catch {}
  return [];
});
ipcMain.handle('clip:writeText', (_e, t) => { clipboard.writeText(t); return true; });

/* Drag out to Finder / other apps */
ipcMain.on('drag:start', async (e, paths) => {
  let icon;
  try { icon = await app.getFileIcon(paths[0], { size: 'normal' }); } catch {}
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'drag.png'));
  try { e.sender.startDrag({ files: paths, file: paths[0], icon }); } catch (err) { console.error(err); }
});

/* Dialogs */
ipcMain.handle('dlg:pickFolder', async (e, title) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dlg:confirm', async (e, opts) => {
  const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'question', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, ...opts });
  return r.response === 0;
});

/* Settings */
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (e, patch) => {
  Object.assign(settings, patch);
  saveSettings();
  for (const w of BrowserWindow.getAllWindows()) if (w.webContents !== e.sender) w.webContents.send('settings:changed', settings);
  if ('theme' in patch) nativeTheme.themeSource = settings.theme;
  return settings;
});

/* Window controls */
ipcMain.handle('win:new', (_e, p) => { createWindow(p); return true; });
ipcMain.handle('win:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); return true; });
ipcMain.handle('win:toggleMax', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});

/* ------------------------------------------------------------------ */
/* Windows & menu                                                      */
/* ------------------------------------------------------------------ */
function createWindow(startPath) {
  const win = new BrowserWindow({
    width: 1240, height: 780, minWidth: 640, minHeight: 420,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'followWindow',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
    title: 'File Explorer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true,
      spellcheck: false,
    },
  });
  const q = startPath ? `?start=${encodeURIComponent(startPath)}` : '';
  win.loadURL(require('url').pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href + q);
  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen', false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith('file://') || !url.includes('/renderer/index.html')) ev.preventDefault(); });
  return win;
}

function send(action, arg) {
  const w = BrowserWindow.getFocusedWindow();
  if (w) w.webContents.send('menu:action', action, arg);
  else if (action === 'newWindow') createWindow();
}

function buildMenu() {
  const a = (label, action, accelerator, extra = {}) => ({ label, accelerator, click: () => send(action), ...extra });
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        a('Folder Options…', 'options', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => send('newWindow') },
        a('New Tab', 'newTab', 'CmdOrCtrl+T'),
        a('New Folder', 'newFolder', 'CmdOrCtrl+Shift+N'),
        a('New Text Document', 'newText'),
        { type: 'separator' },
        a('Open', 'open', 'CmdOrCtrl+O'),
        a('Open in New Tab', 'openNewTab'),
        a('Open in Terminal', 'terminal', 'CmdOrCtrl+Alt+T'),
        { type: 'separator' },
        a('Properties', 'properties', 'CmdOrCtrl+I'),
        a('Rename', 'rename'),
        a('Compress to ZIP file', 'compress'),
        { type: 'separator' },
        a('Delete', 'delete', 'CmdOrCtrl+Backspace'),
        a('Permanently Delete', 'deletePermanent', 'CmdOrCtrl+Alt+Backspace'),
        a('Empty Recycle Bin', 'emptyTrash', 'CmdOrCtrl+Shift+Backspace'),
        { type: 'separator' },
        a('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        a('Undo', 'undo', 'CmdOrCtrl+Z'),
        a('Redo', 'redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        a('Paste Shortcut (Alias)', 'pasteShortcut'),
        a('Copy Path', 'copyPath', 'CmdOrCtrl+Shift+C'),
        { type: 'separator' },
        a('Select All', 'selectAll', 'CmdOrCtrl+A'),
        a('Select None', 'selectNone'),
        a('Invert Selection', 'invertSelection'),
        { type: 'separator' },
        a('Search', 'search', 'CmdOrCtrl+F'),
        a('Edit Address', 'address', 'CmdOrCtrl+L'),
      ],
    },
    {
      label: 'View',
      submenu: [
        a('Extra Large Icons', 'view:xl', 'CmdOrCtrl+Shift+1'),
        a('Large Icons', 'view:large', 'CmdOrCtrl+Shift+2'),
        a('Medium Icons', 'view:medium', 'CmdOrCtrl+Shift+3'),
        a('Small Icons', 'view:small', 'CmdOrCtrl+Shift+4'),
        a('List', 'view:list', 'CmdOrCtrl+Shift+5'),
        a('Details', 'view:details', 'CmdOrCtrl+Shift+6'),
        a('Tiles', 'view:tiles', 'CmdOrCtrl+Shift+7'),
        a('Content', 'view:content', 'CmdOrCtrl+Shift+8'),
        { type: 'separator' },
        a('Preview Pane', 'pane:preview', 'Alt+P'),
        a('Details Pane', 'pane:details', 'Alt+Shift+P'),
        a('Navigation Pane', 'toggleNav'),
        a('Compact View', 'toggleCompact'),
        { type: 'separator' },
        a('Show Hidden Items', 'toggleHidden', 'CmdOrCtrl+Shift+.'),
        a('Show File Name Extensions', 'toggleExt'),
        a('Item Check Boxes', 'toggleCheckboxes'),
        { type: 'separator' },
        a('Refresh', 'refresh', 'CmdOrCtrl+R'),
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        a('Back', 'back', 'CmdOrCtrl+['),
        a('Forward', 'forward', 'CmdOrCtrl+]'),
        a('Up', 'up', 'CmdOrCtrl+Up'),
        { type: 'separator' },
        a('Home', 'go:shell:home', 'CmdOrCtrl+Shift+H'),
        a('This PC', 'go:shell:thispc', 'CmdOrCtrl+Shift+P'),
        a('Desktop', 'go:desktop', 'CmdOrCtrl+Shift+D'),
        a('Documents', 'go:documents', 'CmdOrCtrl+Shift+O'),
        a('Downloads', 'go:downloads', 'CmdOrCtrl+Alt+L'),
        a('Applications', 'go:applications', 'CmdOrCtrl+Shift+A'),
        a('Recycle Bin', 'go:trash'),
        { type: 'separator' },
        a('Go to Folder…', 'address', 'CmdOrCtrl+Shift+G'),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        a('Next Tab', 'nextTab', 'Ctrl+Tab'),
        a('Previous Tab', 'prevTab', 'Ctrl+Shift+Tab'),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        a('Keyboard Shortcuts', 'shortcuts', 'F1'),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  loadSettings();
  nativeTheme.themeSource = settings.theme || 'system';
  nativeTheme.on('updated', () => broadcast('theme:changed', nativeTheme.shouldUseDarkColors));
  app.setAboutPanelOptions({ applicationName: 'File Explorer', applicationVersion: app.getVersion(), copyright: 'A Windows 11 style file manager for macOS' });
  buildMenu();
  createWindow(process.env.FE_START_PATH);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('open-file', (e, p) => {
  e.preventDefault();
  app.whenReady().then(() => createWindow(p));
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
