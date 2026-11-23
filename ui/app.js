// ---------- State, storage, files and the editor ----------
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="studio-token"]')?.content || '';
const tokenWasInjected = token.length >= 40 && !token.startsWith('__');
const servedByLocalBridge = location.protocol === 'http:'
  && (location.hostname === '127.0.0.1' || location.hostname === 'localhost') && tokenWasInjected;

const STORE_KEY = 'codestudio-project-v2';
const LEGACY_KEY = 'jdk21studio-html-project-v1';
const LINE_HEIGHT = 13 * 1.68;

const state = {
  lang: 'java',
  projects: {},
  status: null,
  trace: [], selectedStep: -1, autoTimer: null, pollingTimer: null, polling: false,
  compiled: false, compiling: false, running: false, bridgeReady: false,
  lastCompile: null, sources: {}, errorLines: {}, outChars: 0, saveTimer: null, highlightQueued: false,
};

const showToast = (message) => {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3200);
};

const cfgOf = (lang = state.lang) => LANGUAGES[lang];
const project = () => state.projects[state.lang];

function safeClientFileName(lang, name) {
  const cfg = LANGUAGES[lang];
  if (!cfg || typeof name !== 'string' || name.length > 200 || name.startsWith('/') || name.includes('\\') || name.includes(':')) return false;
  if (!cfg.exts.some((e) => name.toLowerCase().endsWith(e))) return false;
  return name.split('/').every((part) => part && part !== '.' && part !== '..' && /^[A-Za-z0-9_$.-]+$/.test(part));
}

function newProject(lang) {
  const cfg = LANGUAGES[lang];
  return {
    files: { [cfg.defaultFile]: cfg.starter }, active: cfg.defaultFile,
    entry: lang === 'java' ? 'Main' : cfg.defaultFile, std: '', sanitize: false,
  };
}

function sanitizeProject(lang, raw) {
  const base = newProject(lang);
  if (!raw || typeof raw !== 'object' || !raw.files || typeof raw.files !== 'object') return base;
  const entries = Object.entries(raw.files).filter(([n, s]) => safeClientFileName(lang, n) && typeof s === 'string').slice(0, 40);
  if (!entries.length) return base;
  const files = Object.fromEntries(entries);
  const active = Object.hasOwn(files, raw.active) ? raw.active : Object.keys(files).sort()[0];
  let entry = typeof raw.entry === 'string' ? raw.entry : base.entry;
  if (lang === 'java' && !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(entry)) entry = 'Main';
  if (lang !== 'java' && !Object.hasOwn(files, entry)) entry = Object.keys(files).sort().find((n) => !/\.(h|hpp|hh)$/.test(n)) || active;
  return { files, active, entry, std: typeof raw.std === 'string' ? raw.std : '', sanitize: Boolean(raw.sanitize) };
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ lang: state.lang, projects: state.projects }));
  } catch {
    showToast('Browser storage is full or blocked. Export the project to keep a copy.');
  }
}

function restore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* corrupt state is ignored */ }
  if (saved && saved.projects && typeof saved.projects === 'object') {
    LANG_ORDER.forEach((l) => { state.projects[l] = sanitizeProject(l, saved.projects[l]); });
    if (LANGUAGES[saved.lang]) state.lang = saved.lang;
  } else {
    LANG_ORDER.forEach((l) => { state.projects[l] = newProject(l); });
    // Bring over a project saved by the earlier JDK 21 Studio.
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (old && old.files) state.projects.java = sanitizeProject('java', { files: old.files, active: old.activeFile, entry: old.mainClass });
    } catch { /* nothing to migrate */ }
  }
}

// ---------- Files ----------
function sortedNames() { return Object.keys(project().files).sort(); }

function renderFiles() {
  const list = $('fileList');
  list.replaceChildren();
  sortedNames().forEach((name) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `file-item${name === project().active ? ' active' : ''}`;
    button.title = `${name} — double-click to rename`;
    const symbol = document.createElement('span'); symbol.className = 'file-symbol'; symbol.textContent = fileBadge(name);
    const label = document.createElement('span'); label.className = 'file-name'; label.textContent = name;
    button.append(symbol, label);
    button.addEventListener('click', () => switchFile(name));
    button.addEventListener('dblclick', () => renameFile(name));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'file-del'; del.textContent = '×'; del.title = `Delete ${name}`; del.setAttribute('aria-label', `Delete ${name}`);
    del.addEventListener('click', () => deleteFile(name));
    row.append(button, del);
    list.append(row);
  });
  syncEntryOptions();
}

function switchFile(name) {
  if (!Object.hasOwn(project().files, name)) return;
  saveActiveEditor();
  project().active = name;
  loadActiveIntoEditor();
  renderFiles();
  persist();
}

function loadActiveIntoEditor() {
  const p = project();
  $('codeEditor').value = p.files[p.active];
  $('codeEditor').scrollTop = 0; $('codeEditor').scrollLeft = 0;
  $('activeFileName').textContent = p.active;
  $('fileBadge').textContent = fileBadge(p.active);
  $('dirtyMark').hidden = true;
  refreshEditor();
  updateEditorInfo();
}

function updateEditorInfo() {
  const p = project();
  $('editorInfo').textContent = `${cfgOf().label} · UTF-8 · ${p.files[p.active].length.toLocaleString()} chars`;
}

function saveActiveEditor() {
  const p = project();
  if (!p || !Object.hasOwn(p.files, p.active)) return;
  p.files[p.active] = $('codeEditor').value;
  $('dirtyMark').hidden = true;
  updateEditorInfo();
  persist();
}

function addFile() {
  const cfg = cfgOf();
  if (sortedNames().length >= 40) return showToast('A project is limited to 40 files.');
  const name = window.prompt(`New ${cfg.label} file name (you may include a folder, e.g. demo/${cfg.newFile}):`, cfg.newFile);
  if (name === null) return;
  if (!safeClientFileName(state.lang, name)) return showToast(`Use a safe relative file name ending in ${cfg.exts.join(', ')} — no "..", spaces or special characters.`);
  if (Object.hasOwn(project().files, name)) return showToast('That file already exists.');
  saveActiveEditor();
  project().files[name] = cfg.template(name);
  project().active = name;
  loadActiveIntoEditor();
  renderFiles();
  persist();
  $('codeEditor').focus();
}

function renameFile(oldName) {
  const next = window.prompt('Rename file:', oldName);
  if (next === null || next === oldName) return;
  if (!safeClientFileName(state.lang, next)) return showToast('That is not a valid file name for this language.');
  if (Object.hasOwn(project().files, next)) return showToast('A file with that name already exists.');
  saveActiveEditor();
  const p = project();
  p.files = Object.fromEntries(Object.entries(p.files).map(([n, s]) => [n === oldName ? next : n, s]));
  if (p.active === oldName) p.active = next;
  if (state.lang !== 'java' && p.entry === oldName) p.entry = next;
  loadActiveIntoEditor(); renderFiles(); persist();
  if (state.lang === 'java') showToast('Renamed. Remember to rename the public class inside the file too.');
}

function deleteFile(name) {
  const p = project();
  if (sortedNames().length <= 1) return showToast('A project needs at least one file.');
  if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
  saveActiveEditor();
  delete p.files[name];
  if (p.active === name) p.active = sortedNames()[0];
  loadActiveIntoEditor(); renderFiles(); persist();
}

function exportProject() {
  saveActiveEditor();
  const bundle = { app: 'Code Studio', format: 'codestudio-source-bundle-v2', exportedAt: new Date().toISOString(), lang: state.lang, projects: state.projects };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'CodeStudio-project.json';
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  showToast('Project source bundle exported.');
}

async function importProject(file) {
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('The file is too large.');
    const data = JSON.parse(await file.text());
    let count = 0;
    if (data && data.projects && typeof data.projects === 'object') {
      LANG_ORDER.forEach((l) => { if (data.projects[l]) { state.projects[l] = sanitizeProject(l, data.projects[l]); count++; } });
    } else if (data && data.files && typeof data.files === 'object') {
      // Bundle exported by the earlier JDK 21 Studio.
      state.projects.java = sanitizeProject('java', { files: data.files, entry: data.mainClass }); count = 1;
    }
    if (!count) throw new Error('This file is not a Code Studio project bundle.');
    persist();
    applyLanguage();
    showToast(`Imported ${count} project${count > 1 ? 's' : ''}.`);
  } catch (error) {
    showToast(`Import failed: ${error.message}`);
  } finally { $('importInput').value = ''; }
}

// ---------- Toolbar fields that depend on the language ----------
function syncEntryOptions() {
  const lang = state.lang;
  if (lang !== 'python') return;
  const p = project();
  const select = $('entrySelect');
  const isSource = (n) => n.endsWith('.py');
  const options = sortedNames().filter(isSource);
  if (!options.includes(p.entry)) p.entry = options.includes(cfgOf().defaultFile) ? cfgOf().defaultFile : (options[0] || p.entry);
  select.replaceChildren(...options.map((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; return o; }));
  select.value = p.entry;
}

function syncStdOptions() {
  const t = state.status && state.status.tools[state.lang];
  const select = $('stdSelect');
  select.replaceChildren();
  const list = t && t.standards ? t.standards : [];
  list.forEach((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.label; select.append(o); });
  const p = project();
  if (!list.some((s) => s.id === p.std)) p.std = t && t.defaultStd ? t.defaultStd : '';
  select.value = p.std;
  $('sanitizeLabel').hidden = !(t && t.sanitize);
  $('sanitizeInput').checked = Boolean(p.sanitize && t && t.sanitize);
}

// ---------- Editor view: gutter, highlighting, scroll sync ----------
function updateLineNumbers() {
  const ed = $('codeEditor');
  const count = ed.value.split('\n').length;
  const bad = (state.errorLines[project().active]) || new Set();
  const parts = [];
  for (let i = 1; i <= count; i++) parts.push(bad.has(i) ? `<span class="ln-err">${i}</span>` : String(i));
  $('lineNumbers').innerHTML = parts.join('\n');
  $('lineNumbers').scrollTop = ed.scrollTop;
}

function syncOverlay() {
  const ed = $('codeEditor'); const hl = $('codeHighlight');
  const sbH = ed.offsetHeight - ed.clientHeight; const sbW = ed.offsetWidth - ed.clientWidth;
  hl.style.paddingBottom = `${18 + Math.max(0, sbH)}px`;
  hl.style.paddingRight = `${20 + Math.max(0, sbW)}px`;
  hl.scrollTop = ed.scrollTop; hl.scrollLeft = ed.scrollLeft;
  $('lineNumbers').scrollTop = ed.scrollTop;
}

function renderHighlight() {
  $('codeHighlight').innerHTML = highlightCode($('codeEditor').value, state.lang);
  syncOverlay();
}

function scheduleHighlight() {
  if (state.highlightQueued) return;
  state.highlightQueued = true;
  window.requestAnimationFrame(() => { state.highlightQueued = false; renderHighlight(); });
}

function refreshEditor() { updateLineNumbers(); renderHighlight(); }

function jumpTo(file, line, column) {
  if (file && Object.hasOwn(project().files, file) && file !== project().active) switchFile(file);
  if (!line) return;
  const ed = $('codeEditor');
  const lines = ed.value.split('\n');
  const idx = Math.min(Math.max(line, 1), lines.length) - 1;
  let start = 0; for (let i = 0; i < idx; i++) start += lines[i].length + 1;
  const col = Math.min(Math.max((column || 1) - 1, 0), lines[idx].length);
  ed.focus();
  ed.setSelectionRange(start + col, start + col);
  ed.scrollTop = Math.max(0, idx * LINE_HEIGHT - ed.clientHeight / 2);
  syncOverlay();
}

// ---------- Editing helpers (undo-friendly) ----------
function lineStartOf(v, pos) { return v.lastIndexOf('\n', pos - 1) + 1; }
function lineEndOf(v, pos) { const i = v.indexOf('\n', pos); return i < 0 ? v.length : i; }

function replaceRange(ed, start, end, text, selStart, selEnd) {
  ed.focus();
  ed.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) { ed.setRangeText(text, start, end, 'end'); ed.dispatchEvent(new Event('input', { bubbles: true })); }
  ed.setSelectionRange(selStart, selEnd);
}

function indentSelection(ed, outdent) {
  const v = ed.value; const s = ed.selectionStart; const e = ed.selectionEnd;
  if (!outdent && s === e) { replaceRange(ed, s, e, '    ', s + 4, s + 4); return; }
  if (!outdent && !v.slice(s, e).includes('\n')) { replaceRange(ed, s, e, '    ', s + 4, s + 4); return; }
  const first = lineStartOf(v, s);
  const lastPos = e > s && v[e - 1] === '\n' ? e - 1 : e;
  const last = lineEndOf(v, lastPos);
  const block = v.slice(first, last).split('\n').map((line) => (outdent ? line.replace(/^( {1,4}|\t)/, '') : (line ? `    ${line}` : line))).join('\n');
  if (block === v.slice(first, last)) return;
  replaceRange(ed, first, last, block, first, first + block.length);
}

function toggleComment(ed) {
  const token = cfgOf().comment;
  const v = ed.value; const s = ed.selectionStart; const e = ed.selectionEnd;
  const first = lineStartOf(v, s);
  const lastPos = e > s && v[e - 1] === '\n' ? e - 1 : e;
  const last = lineEndOf(v, lastPos);
  const lines = v.slice(first, last).split('\n');
  const active = lines.filter((l) => l.trim());
  if (!active.length) return;
  const allCommented = active.every((l) => l.trimStart().startsWith(token));
  const minIndent = Math.min(...active.map((l) => /^[ \t]*/.exec(l)[0].length));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    if (allCommented) return l.replace(new RegExp(`^([ \\t]*)${token.replace(/[/#]/g, '\\$&')} ?`), '$1');
    return `${l.slice(0, minIndent)}${token} ${l.slice(minIndent)}`;
  }).join('\n');
  replaceRange(ed, first, last, out, first, first + out.length);
}

function handleEnter(ed, event) {
  const v = ed.value; const s = ed.selectionStart; const e = ed.selectionEnd;
  const ls = lineStartOf(v, s);
  const before = v.slice(ls, s);
  const indent = /^[ \t]*/.exec(before)[0];
  let code = before.trimEnd();
  const cfg = cfgOf();
  let extra = '';
  if (cfg.braces) { if (/[{(\[]$/.test(code)) extra = '    '; }
  else { code = code.replace(/\s+#.*$/, ''); if (code.endsWith(':') && !/^\s*#/.test(code)) extra = '    '; }
  const next = v[e];
  let text; let caret;
  if (cfg.braces && extra && ((code.endsWith('{') && next === '}') || (code.endsWith('(') && next === ')') || (code.endsWith('[') && next === ']'))) {
    text = `\n${indent}${extra}\n${indent}`; caret = s + 1 + indent.length + extra.length;
  } else { text = `\n${indent}${extra}`; caret = s + text.length; }
  event.preventDefault();
  replaceRange(ed, s, e, text, caret, caret);
}

function onEditorKeydown(event) {
  const ed = event.currentTarget;
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === 'Tab' && !mod && !event.altKey) { event.preventDefault(); indentSelection(ed, event.shiftKey); return; }
  if (event.key === 'Enter' && !mod && !event.shiftKey && !event.altKey && !event.isComposing) { handleEnter(ed, event); return; }
  if (mod && event.key === 'Enter') { event.preventDefault(); if (!$('runBtn').disabled) $('runBtn').click(); return; }
  if (mod && event.key === '/') { event.preventDefault(); toggleComment(ed); return; }
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveActiveEditor(); showToast('Saved in this browser. Export a bundle for a backup.'); return; }
  if (event.key === '}' && cfgOf().braces && ed.selectionStart === ed.selectionEnd && !mod) {
    // Typing a closing brace on an indented blank line pulls it back one level.
    const v = ed.value; const s = ed.selectionStart; const ls = lineStartOf(v, s);
    const before = v.slice(ls, s);
    if (before.length >= 4 && /^ +$/.test(before)) { event.preventDefault(); replaceRange(ed, s - 4, s, '}', s - 3, s - 3); }
  }
}
