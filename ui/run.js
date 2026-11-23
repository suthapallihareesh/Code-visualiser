// ---------- Bridge, compile, run, console, walkthrough, boot ----------
const LOST_CONNECTION = 'Code Studio lost contact with its launcher. Make sure the launcher window (run.bat / run.sh) is still open, then refresh this page.';
const toolOf = (lang = state.lang) => (state.status && state.status.tools ? state.status.tools[lang] : null);
const langReady = (lang = state.lang) => Boolean(toolOf(lang) && toolOf(lang).ready);

const api = async (route, values = {}) => {
  if (!servedByLocalBridge || !state.bridgeReady) {
    throw new Error('Start Code Studio with run.bat (Windows) or run.sh (macOS/Linux) to compile and run programs.');
  }
  const body = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => body.set(key, String(value)));
  let response;
  try {
    response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Studio-Token': token },
      body, cache: 'no-store',
    });
  } catch { throw new Error(LOST_CONNECTION); }
  let data;
  try { data = await response.json(); } catch { throw new Error(LOST_CONNECTION); }
  if (!response.ok) throw new Error(data.error || LOST_CONNECTION);
  return data;
};

// ---------- Launch / install help (shown in the console, no banner) ----------
function setLaunchHelp(title, message, steps = [], command = '') {
  const lines = [title, '', message];
  if (steps.length) lines.push('', ...steps.map((s, i) => `${i + 1}. ${s}`));
  if (command) lines.push('', command);
  setConsoleText(lines.join('\n'), 'sys');
}
const clearLaunchHelp = () => {};

function showMissingToolHelp() {
  const t = toolOf();
  if (!t || t.ready) return false;
  setLaunchHelp(`${cfgOf().label} is not installed on this computer`, t.detail || 'The toolchain was not found.', [
    'Install it with the command below (on Windows run it in PowerShell or Windows Terminal).',
    'Close the Code Studio launcher window and start run.bat / run.sh again.',
    'Or click the status badge at the top right to re-check without restarting.',
  ], t.hint || '');
  return true;
}

function updateConnectionBadge() {
  const badge = $('connectionBadge');
  const t = toolOf();
  if (!state.bridgeReady) {
    badge.className = 'status-pill offline';
    badge.innerHTML = '<i></i><span>Not connected</span>';
  } else if (t && t.ready) {
    badge.className = 'status-pill online';
    badge.innerHTML = '<i></i><span></span>';
    badge.lastElementChild.textContent = `${t.name} ${t.version} · Offline ready`;
  } else {
    badge.className = 'status-pill offline';
    badge.innerHTML = '<i></i><span></span>';
    badge.lastElementChild.textContent = `${cfgOf().label} not installed`;
  }
  const t2 = toolOf();
  $('chipIcon').textContent = cfgOf().icon;
  $('chipText').textContent = t2 && t2.ready ? `${t2.name} ${t2.version}` : `${cfgOf().label} (missing)`;
}

function updateControls() {
  const ready = state.bridgeReady && langReady();
  $('compileBtn').disabled = !ready || state.compiling;
  $('runBtn').disabled = !ready || state.compiling;
  $('stopBtn').disabled = !(state.bridgeReady && (state.compiling || state.running));
  $('stopBtn').textContent = state.compiling ? '■ Stop compile' : '■ Stop';
  $('newFileBtn').disabled = state.compiling;
  document.querySelectorAll('.lang-btn').forEach((b) => { b.disabled = state.compiling || state.running; });
  $('sendInputBtn').disabled = !state.running;
  $('finishInputBtn').disabled = !state.running;
  $('stdinInput').disabled = !state.running;
  $('runtimeState').classList.toggle('running', state.running);
}

function renderLangSwitch() {
  const nav = $('langSwitch');
  nav.replaceChildren();
  LANG_ORDER.forEach((id) => {
    const t = toolOf(id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.lang = id;
    btn.className = `lang-btn${id === state.lang ? ' active' : ''}${t ? (t.ready ? ' ok' : ' missing') : ''}`;
    const dot = document.createElement('i'); dot.className = 'lang-dot';
    const label = document.createElement('span'); label.textContent = LANGUAGES[id].label;
    btn.append(dot, label);
    btn.title = t ? (t.ready ? `${t.name} ${t.version}` : `${LANGUAGES[id].label} is not installed`) : LANGUAGES[id].label;
    btn.addEventListener('click', () => setLanguage(id));
    nav.append(btn);
  });
  nav.querySelectorAll('.lang-btn').forEach((b) => { b.disabled = state.compiling || state.running; });
}

/** Applies the current language to every part of the interface. */
function applyLanguage() {
  const cfg = cfgOf();
  const p = project();
  stopAuto();
  state.trace = []; state.selectedStep = -1; state.compiled = false; state.errorLines = {};
  renderTrace();
  $('diagnosticsPanel').hidden = true;
  $('mainClassGroup').hidden = state.lang !== 'java';
  $('entryGroup').hidden = state.lang !== 'python';
  $('stdGroup').hidden = !(state.lang === 'c' || state.lang === 'cpp');
  $('mainClassInput').value = state.lang === 'java' ? p.entry : 'Main';
  $('compileBtn').textContent = cfg.kind === 'interpreted' ? 'Check' : 'Compile';
  $('compileBtn').title = cfg.kind === 'interpreted' ? 'Run the real syntax and bytecode checks without executing' : 'Compile without running';
  $('traceEyebrow').textContent = cfg.eyebrow;
  $('traceFootnote').textContent = cfg.footnote;
  $('diagEyebrow').textContent = cfg.kind === 'interpreted' ? 'SYNTAX REPORT' : 'COMPILER REPORT';
  $('compileStatus').textContent = state.bridgeReady && langReady() ? 'Ready' : 'Not available';
  renderLangSwitch();
  renderFiles();
  if (state.lang === 'c' || state.lang === 'cpp') syncStdOptions();
  loadActiveIntoEditor();
  updateConnectionBadge();
  updateControls();
  if (state.bridgeReady && !showMissingToolHelp()) setConsoleText(`${cfg.label} is ready. Press Run to compile and execute your program.`);
  else if (!state.bridgeReady && !$('consoleOutput').textContent) setConsoleText('Your program output will appear here.');
  $('runtimeState').textContent = 'Idle';
  persist();
}

function setLanguage(lang) {
  if (lang === state.lang || !LANGUAGES[lang]) return;
  if (state.compiling || state.running) { showToast('Stop the running program before switching language.'); return; }
  saveActiveEditor();
  state.lang = lang;
  applyLanguage();
}

// ---------- Console ----------
function setConsoleText(text, cls = '') {
  const out = $('consoleOutput');
  out.replaceChildren();
  state.outChars = 0;
  if (text) appendOutput([{ s: cls || 'plain', t: text }]);
}

function appendOutput(chunks) {
  const out = $('consoleOutput');
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  chunks.forEach((c) => {
    if (!c.t) return;
    const span = document.createElement('span');
    if (c.s && c.s !== 'plain') span.className = `out-${c.s}`;
    span.textContent = c.t;
    out.append(span);
    state.outChars += c.t.length;
  });
  while (state.outChars > 600000 && out.firstChild && out.childNodes.length > 1) {
    state.outChars -= out.firstChild.textContent.length;
    out.removeChild(out.firstChild);
  }
  if (nearBottom) out.scrollTop = out.scrollHeight;
}

// ---------- Compile ----------
function validateProjectBeforeCompile() {
  const p = project();
  if (state.lang === 'java' && !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test($('mainClassInput').value.trim())) {
    showToast('Enter a valid main class, such as Main or demo.Main.');
    return false;
  }
  if (!Object.keys(p.files).length) { showToast('Add at least one source file.'); return false; }
  return true;
}

async function compileProject() {
  stopAuto();
  saveActiveEditor();
  if (!validateProjectBeforeCompile()) return false;
  const lang = state.lang;
  const cfg = cfgOf();
  const p = project();
  const names = sortedNames();
  const form = { lang, count: names.length };
  if (lang === 'java') form.mainClass = $('mainClassInput').value.trim();
  if (lang === 'python') form.entry = p.entry;
  if (lang === 'c' || lang === 'cpp') { form.std = p.std; form.sanitize = p.sanitize ? 1 : 0; }
  names.forEach((name, i) => { form[`name${i}`] = name; form[`source${i}`] = p.files[name]; });
  state.sources = { ...p.files };

  // A program that is still running is replaced by the new build.
  if (state.running) { stopPolling(); state.running = false; }
  state.compiling = true; state.compiled = false;
  updateControls();
  $('compileStatus').textContent = `Compiling with local ${cfg.id === 'java' ? 'javac' : cfg.label}…`;
  $('diagnosticsPanel').hidden = true;
  setConsoleText(cfg.kind === 'interpreted' ? `Checking with the real ${cfg.label} toolchain…` : `Compiling with the locally installed ${cfg.label} toolchain…`);
  $('runtimeState').textContent = cfg.kind === 'interpreted' ? 'Checking' : 'Compiling';
  try {
    const result = await api('/api/compile', form);
    if (lang !== state.lang) return false; // language was switched while waiting
    state.trace = Array.isArray(result.trace) ? result.trace : [];
    state.selectedStep = state.trace.length ? 0 : -1;
    state.compiled = Boolean(result.success);
    state.lastCompile = result;
    $('traceEyebrow').textContent = result.traceTitle || cfg.eyebrow;
    renderTrace();
    renderDiagnostics(result.diagnostics || []);
    const warnings = (result.diagnostics || []).filter((d) => d.kind === 'WARNING').length;
    if (result.cancelled) {
      $('compileStatus').textContent = 'Stopped';
      setConsoleText('Compilation stopped.', 'sys');
      $('runtimeState').textContent = 'Stopped';
      return false;
    }
    if (result.success) {
      const done = cfg.kind === 'interpreted' ? 'Check passed' : 'Compilation successful';
      $('compileStatus').textContent = `${done} · ${result.compilerName || cfg.label}${warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`;
      setConsoleText(`${done}. Select Run to execute your program.`);
      $('runtimeState').textContent = cfg.kind === 'interpreted' ? 'Checked' : 'Compiled';
      showToast(`${done}.`);
    } else {
      $('compileStatus').textContent = 'Failed · see diagnostics';
      const fatal = (result.diagnostics || []).find((d) => d.kind === 'ERROR' && !d.line && !d.source);
      setConsoleText(fatal ? fatal.message : 'Review the diagnostics and the compiler walkthrough.', 'err');
      $('runtimeState').textContent = cfg.kind === 'interpreted' ? 'Syntax error' : 'Compile error';
      showToast('Compilation failed. See the diagnostics below the editor.');
    }
    return state.compiled;
  } catch (error) {
    state.compiled = false;
    $('compileStatus').textContent = 'Could not compile';
    $('runtimeState').textContent = 'Error';
    setConsoleText(error.message, 'err');
    showToast(error.message);
    return false;
  } finally {
    state.compiling = false;
    updateControls();
  }
}

function sourceContext(d) {
  const text = (state.sources[d.source] || '').split('\n')[d.line - 1];
  if (text === undefined) return '';
  const shown = text.length > 160 ? `${text.slice(0, 160)}…` : text;
  return d.column ? `${shown}\n${' '.repeat(Math.max(0, Math.min(d.column, 160) - 1))}^` : shown;
}

function renderDiagnostics(items) {
  const panel = $('diagnosticsPanel');
  const list = $('diagnosticsList');
  list.replaceChildren();
  state.errorLines = {};
  $('diagnosticCount').textContent = String(items.length);
  panel.hidden = items.length === 0;
  items.forEach((item) => {
    if (item.kind === 'ERROR' && item.source && item.line) (state.errorLines[item.source] ||= new Set()).add(item.line);
    const row = document.createElement('div');
    row.className = `diagnostic ${item.kind === 'ERROR' ? 'error' : item.kind === 'NOTE' ? 'note' : 'warning'}`;
    const head = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = item.kind || 'NOTE';
    head.append(strong);
    if (item.source || item.line) {
      const location = document.createElement('span'); location.className = 'location';
      location.textContent = ` · ${item.source || 'source'}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''}`;
      head.append(location);
    }
    const message = document.createElement('div'); message.className = 'diag-msg'; message.textContent = item.message || '';
    row.append(head, message);
    const ctx = item.context || (item.line ? sourceContext(item) : '');
    if (ctx) { const pre = document.createElement('pre'); pre.className = 'diag-context'; pre.textContent = ctx; row.append(pre); }
    if (item.source && item.line) {
      row.title = 'Click to jump to this line';
      row.addEventListener('click', () => jumpTo(item.source, item.line, item.column));
    }
    list.append(row);
  });
  updateLineNumbers();
}

// ---------- Compiler walkthrough ----------
function renderTrace() {
  const list = $('traceList');
  list.replaceChildren();
  if (!state.trace.length) {
    const empty = document.createElement('div'); empty.className = 'trace-empty';
    const icon = document.createElement('div'); icon.className = 'trace-empty-icon'; icon.textContent = '⌁';
    const title = document.createElement('strong');
    const text = document.createElement('span');
    if (state.lastCompile && state.compiled === false && state.lastCompile.lang === state.lang) {
      title.textContent = 'No compiler steps captured'; text.textContent = 'The toolchain stopped before reporting any steps. See the diagnostics.';
    } else { title.textContent = 'Waiting for compilation'; text.textContent = 'Compile your program to capture the real compiler steps.'; }
    empty.append(icon, title, text); list.append(empty);
    selectTraceStep(-1);
    return;
  }
  state.trace.forEach((step, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `trace-item${index === state.selectedStep ? ' selected' : ''}${step.moment === 'FAILED' ? ' failed' : ''}`;
    const number = document.createElement('span'); number.className = 'trace-index'; number.textContent = String(index + 1).padStart(2, '0');
    const label = document.createElement('span'); label.className = 'trace-label';
    const title = document.createElement('b'); title.textContent = step.title || step.phase;
    const detail = document.createElement('small'); detail.textContent = step.source || step.detail || 'Compiler step';
    label.append(title, detail);
    const moment = document.createElement('span'); moment.className = 'trace-moment'; moment.textContent = step.moment || '';
    row.append(number, label, moment);
    row.addEventListener('click', () => { stopAuto(); selectTraceStep(index); });
    list.append(row);
  });
  updateTraceControls();
  selectTraceStep(state.selectedStep, false);
}

function selectTraceStep(index, scroll = true) {
  state.selectedStep = index;
  const step = state.trace[index];
  const items = $('traceList').querySelectorAll('.trace-item');
  items.forEach((item, i) => item.classList.toggle('selected', i === index));
  if (!step) {
    $('stepPhase').textContent = 'NO STEP';
    $('stepTitle').textContent = 'No compiler step selected';
    $('stepExplanation').textContent = 'Compile your code to capture the real compiler steps.';
    $('stepSource').hidden = true; $('stepSnippet').hidden = true;
  } else {
    $('stepPhase').textContent = `${step.phase} · ${step.moment}`;
    $('stepTitle').textContent = step.title || step.phase;
    $('stepExplanation').textContent = step.explanation || '';
    const bits = [];
    if (step.source) bits.push(`Source: ${step.source}`);
    if (step.detail) bits.push(step.detail);
    if (typeof step.ms === 'number' && step.ms > 0) bits.push(`${step.ms} ms`);
    else if (typeof step.t === 'number') bits.push(`t+${step.t} ms`);
    $('stepSource').textContent = bits.join(' · ');
    $('stepSource').hidden = bits.length === 0;
    $('stepSnippet').textContent = step.snippet || '';
    $('stepSnippet').hidden = !step.snippet;
    if (scroll && items[index]) items[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  updateTraceControls();
}

function updateTraceControls() {
  const has = state.trace.length > 0;
  const index = state.selectedStep;
  $('firstStepBtn').disabled = !has || index <= 0;
  $('previousStepBtn').disabled = !has || index <= 0;
  $('nextStepBtn').disabled = !has || index >= state.trace.length - 1;
  $('lastStepBtn').disabled = !has || index >= state.trace.length - 1;
  $('autoStepBtn').disabled = !has || state.autoTimer !== null;
  $('pauseStepBtn').disabled = state.autoTimer === null;
  const current = has ? index + 1 : 0;
  const percent = has ? Math.round((current / state.trace.length) * 100) : 0;
  $('traceCounter').textContent = has ? `Step ${current} of ${state.trace.length}` : 'No trace yet';
  $('tracePercent').textContent = `${percent}%`;
  $('traceProgress').style.width = `${percent}%`;
}

function moveStep(next) {
  stopAuto();
  if (!state.trace.length) return;
  selectTraceStep(Math.max(0, Math.min(state.trace.length - 1, next)));
}

function stopAuto() {
  if (state.autoTimer !== null) window.clearInterval(state.autoTimer);
  state.autoTimer = null;
  updateTraceControls();
}

function startAuto() {
  if (!state.trace.length) return;
  stopAuto();
  if (state.selectedStep >= state.trace.length - 1) selectTraceStep(0);
  state.autoTimer = window.setInterval(() => {
    if (state.selectedStep >= state.trace.length - 1) { stopAuto(); return; }
    selectTraceStep(state.selectedStep + 1, true);
  }, 850);
  updateTraceControls();
}

// ---------- Run ----------
const SIGNALS = { SIGSEGV: 'crashed: segmentation fault (invalid memory access)', SIGABRT: 'aborted', SIGKILL: 'was killed', SIGFPE: 'crashed: arithmetic error (e.g. division by zero)', SIGILL: 'crashed: illegal instruction', SIGBUS: 'crashed: bus error', SIGTERM: 'was terminated' };
function describeExit(result) {
  if (result.timedOut) return '[Stopped: the 10 minute run limit was reached.]';
  if (result.stopped) return '[Stopped by you.]';
  if (result.signal) return `[Program ${SIGNALS[result.signal] || `ended with signal ${result.signal}`}.]`;
  if (result.exitCode === 3221225477 || result.exitCode === -1073741819) return '[Program crashed: memory access violation (segmentation fault).]';
  if (result.exitCode === 0) return '';
  return `[Program finished with exit code ${result.exitCode ?? 'unknown'}.]`;
}

function stopPolling() {
  if (state.pollingTimer) window.clearInterval(state.pollingTimer);
  state.pollingTimer = null;
}

async function startRun() {
  try {
    $('runtimeState').textContent = 'Starting…';
    const result = await api('/api/run', { lang: state.lang });
    if (!result.started) throw new Error('The program could not be started.');
    setConsoleText('');
    $('runtimeState').textContent = 'Running';
    state.running = true;
    updateControls();
    beginPolling();
    $('stdinInput').focus();
  } catch (error) {
    $('runtimeState').textContent = 'Run failed';
    state.running = false;
    updateControls();
    setConsoleText(error.message, 'err');
    showToast(error.message);
  }
}

function beginPolling() {
  stopPolling();
  state.pollingTimer = window.setInterval(pollOutput, 120);
  pollOutput();
}

async function pollOutput() {
  if (state.polling) return;
  state.polling = true;
  try {
    const result = await api('/api/poll');
    if (result.output && result.output.length) appendOutput(result.output);
    if (!result.running) {
      stopPolling();
      state.running = false;
      const ending = describeExit(result);
      if (ending) appendOutput([{ s: 'sys', t: `${$('consoleOutput').textContent && !$('consoleOutput').textContent.endsWith('\n') ? '\n' : ''}${ending}\n` }]);
      updateControls();
      if (result.timedOut) $('runtimeState').textContent = 'Timed out';
      else if (result.stopped) $('runtimeState').textContent = 'Stopped';
      else $('runtimeState').textContent = `Finished · exit ${result.exitCode ?? result.signal ?? 'unknown'}`;
    }
  } catch (error) {
    stopPolling();
    state.running = false;
    $('runtimeState').textContent = 'Connection lost';
    updateControls();
    showToast(error.message);
  } finally { state.polling = false; }
}

async function sendProgramInput(event) {
  event.preventDefault();
  const input = $('stdinInput');
  if (!state.running) return;
  const value = input.value;
  try {
    await api('/api/input', { input: value });
    appendOutput([{ s: 'in', t: `${value}\n` }]); // terminals echo typed input; a pipe does not
    input.value = '';
    input.focus();
  } catch (error) { showToast(error.message); }
}

async function stopProgram() {
  try {
    await api('/api/stop');
    if (state.running) $('runtimeState').textContent = 'Stopping…';
    showToast('Stop requested.');
  } catch (error) { showToast(error.message); }
}

async function finishInput() {
  try {
    await api('/api/finish-input');
    $('finishInputBtn').disabled = true;
    appendOutput([{ s: 'sys', t: '^D\n' }]);
    showToast('Standard input closed (EOF).');
  } catch (error) { showToast(error.message); }
}

async function runProject() {
  const success = await compileProject();
  if (!success) return;
  let trusted = false;
  try { trusted = sessionStorage.getItem('codestudio-trusted') === '1'; } catch { trusted = false; }
  if (trusted) await startRun(); else $('trustDialog').showModal();
}

// ---------- Bridge check ----------
async function checkBridge(refresh = false) {
  $('connectionBadge').className = 'status-pill checking';
  $('connectionBadge').innerHTML = '<i></i><span>Checking local toolchains…</span>';
  if (location.protocol === 'file:') {
    setLaunchHelp('Start Code Studio with its launcher',
      'This page was opened directly as a file, so programs cannot be compiled or run from it yet.', [
        'Close this tab.',
        'Extract the complete Code Studio package.',
        'Double-click run.bat (Windows) or run.sh (macOS/Linux) and keep its window open.',
        'Use the browser tab it opens at http://127.0.0.1:32121/.',
      ]);
    state.bridgeReady = false;
    updateConnectionBadge(); updateControls();
    $('footerStatus').textContent = 'Open the complete package with run.bat — do not double-click the .html file.';
    $('compileStatus').textContent = 'Launcher not started';
    $('runtimeState').textContent = 'Not connected';
    return;
  }
  if (!servedByLocalBridge) {
    setLaunchHelp('Open the IDE through the local launcher',
      'This page was not opened by the Code Studio launcher, so programs cannot be compiled or run from it.',
      ['Start run.bat (Windows) or run.sh (macOS/Linux).', 'Use the address it prints, normally http://127.0.0.1:32121/.']);
    state.bridgeReady = false;
    updateConnectionBadge(); updateControls();
    $('footerStatus').textContent = 'Use run.bat / run.sh and keep the launcher window open.';
    return;
  }
  try {
    const response = await fetch(`/api/status${refresh ? '?refresh=1' : ''}`, { headers: { 'X-Studio-Token': token }, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch { throw new Error(LOST_CONNECTION); }
    if (!response.ok) throw new Error(data.error || LOST_CONNECTION);
    state.status = data;
    state.bridgeReady = true;
    const ready = LANG_ORDER.filter((l) => data.tools[l] && data.tools[l].ready).map((l) => LANGUAGES[l].label);
    $('footerStatus').textContent = ready.length ? `Connected · ${ready.join(', ')} ready · Real compilers` : 'Connected · no compilers found yet';
    clearLaunchHelp();
    if (state.running || state.compiling) { renderLangSwitch(); updateConnectionBadge(); showMissingToolHelp(); }
    else applyLanguage();
    if (refresh) showToast('Toolchains re-checked.');
  } catch (error) {
    state.bridgeReady = false;
    setLaunchHelp('Code Studio cannot reach its launcher',
      'The launcher window may have been closed.',
      ['Restart run.bat / run.sh and keep its window open.', 'Then refresh this tab.']);
    updateConnectionBadge(); updateControls();
    $('footerStatus').textContent = 'Launcher not responding.';
    $('compileStatus').textContent = 'Launcher unavailable';
    $('runtimeState').textContent = 'Not connected';
    setConsoleText(LOST_CONNECTION, 'err');
  }
}

// ---------- Events and boot ----------
function wireEvents() {
  const ed = $('codeEditor');
  $('newFileBtn').addEventListener('click', addFile);
  $('exportBtn').addEventListener('click', exportProject);
  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => importProject(e.target.files[0]));
  $('connectionBadge').addEventListener('click', () => checkBridge(true));
  ed.addEventListener('input', () => {
    $('dirtyMark').hidden = false;
    state.compiled = false;
    state.errorLines = {};
    updateLineNumbers();
    scheduleHighlight();
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveActiveEditor, 700);
  });
  ed.addEventListener('scroll', syncOverlay);
  ed.addEventListener('keydown', onEditorKeydown);
  if (window.ResizeObserver) new ResizeObserver(syncOverlay).observe(ed);
  window.addEventListener('resize', syncOverlay);
  $('mainClassInput').addEventListener('input', () => { if (state.lang === 'java') { project().entry = $('mainClassInput').value.trim(); persist(); } });
  $('entrySelect').addEventListener('change', () => { project().entry = $('entrySelect').value; persist(); });
  $('stdSelect').addEventListener('change', () => { project().std = $('stdSelect').value; persist(); });
  $('sanitizeInput').addEventListener('change', () => { project().sanitize = $('sanitizeInput').checked; persist(); });
  $('compileBtn').addEventListener('click', compileProject);
  $('runBtn').addEventListener('click', runProject);
  $('cancelRunBtn').addEventListener('click', () => $('trustDialog').close());
  $('confirmRunBtn').addEventListener('click', async () => {
    if ($('trustRemember').checked) { try { sessionStorage.setItem('codestudio-trusted', '1'); } catch { /* remembered only for this page */ } }
    $('trustDialog').close();
    await startRun();
  });
  $('stopBtn').addEventListener('click', stopProgram);
  $('stdinForm').addEventListener('submit', sendProgramInput);
  $('stdinInput').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); finishInput(); } });
  $('finishInputBtn').addEventListener('click', finishInput);
  $('clearConsoleBtn').addEventListener('click', () => setConsoleText(''));
  $('firstStepBtn').addEventListener('click', () => moveStep(0));
  $('previousStepBtn').addEventListener('click', () => moveStep(state.selectedStep - 1));
  $('nextStepBtn').addEventListener('click', () => moveStep(state.selectedStep + 1));
  $('lastStepBtn').addEventListener('click', () => moveStep(state.trace.length - 1));
  $('autoStepBtn').addEventListener('click', startAuto);
  $('pauseStepBtn').addEventListener('click', stopAuto);
  window.addEventListener('beforeunload', saveActiveEditor);
}

restore();
wireEvents();
renderLangSwitch();
applyLanguage();
checkBridge();
