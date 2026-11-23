#!/usr/bin/env node
'use strict';
/*
 * Code Studio local bridge.
 * Serves the IDE page and drives the REAL compilers/interpreters installed on this computer:
 * JDK (javac/java), GCC or Clang (C and C++) and CPython. No dependencies, no cloud, no API quota.
 * Listens on 127.0.0.1 only; every API call needs a per-run secret token injected into the page.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const { detectAll } = require('./lib/detect');
const { compile, LANGS } = require('./lib/compile');
const { killTree, isWin } = require('./lib/proc');

const VERSION = '2.0.0';
const UI_DIR = path.join(__dirname, 'ui');
const BASE_PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7)) || 32121;
const NO_OPEN = process.argv.includes('--no-open');
const MAX_BODY = 4 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const RUN_LIMIT_MS = 10 * 60 * 1000;

const token = crypto.randomBytes(24).toString('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-'));
let port = BASE_PORT;
let tools = null;
let counter = 0;
let compiling = null;   // { ws, cancelled }
let build = null;       // last successful/failed build { ws, lang, run, runError }
let current = null;     // running program

// ---------------------------------------------------------------- helpers
const GENERIC_ERROR = 'Something went wrong while handling that request. Please try again. If it keeps happening, restart the Code Studio launcher.';
/** Technical details go to the launcher window (for whoever runs Code Studio), never into the IDE. */
const logInternal = (what, detail) => console.error(`[internal] ${what}${detail ? `: ${String(detail).trim().split('\n').slice(0, 6).join(' | ')}` : ''}`);

/** Removes temporary working-folder paths so users only ever see their own file names. */
function makeScrubber(ws) {
  const variants = new Set();
  [ws.srcDir, ws.buildDir, ws.dir, root].forEach((p) => { if (p) { variants.add(p); variants.add(p.replace(/\\/g, '/')); } });
  const list = [...variants].sort((a, b) => b.length - a.length);
  return (text) => {
    let t = String(text == null ? '' : text);
    for (const v of list) t = t.split(`${v}/`).join('').split(`${v}\\`).join('').split(v).join('');
    return t;
  };
}
const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
};

const hostOk = (req) => {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
};
const originOk = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
};
const tokenOk = (req) => {
  const given = Buffer.from(String(req.headers['x-studio-token'] || ''));
  const want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('The request is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const publicTool = (t) => {
  const { ready, name, version, detail, hint, standards, defaultStd, sanitize } = t;
  return { ready, name, version, detail, hint, standards, defaultStd, sanitize };
};

function cleanWorkspace(ws) {
  if (!ws) return;
  try { fs.rmSync(ws.dir, { recursive: true, force: true }); } catch { /* a locked file will be removed on exit */ }
}

function stopCurrent(reason) {
  if (!current || current.done) return;
  current.stopped = reason === 'user';
  killTree(current.child);
}

// ---------------------------------------------------------------- page
function renderPage(nonce) {
  const read = (f) => fs.readFileSync(path.join(UI_DIR, f), 'utf8');
  const js = ['languages.js', 'highlight.js', 'app.js', 'run.js'].map(read).join('\n');
  return read('index.html')
    .replace('{{CSS}}', () => read('style.css'))
    .replace('{{JS}}', () => js)
    .replace('content="__STUDIO_TOKEN__"', () => `content="${token}"`)
    .replace(/nonce="__STUDIO_NONCE__"/g, () => `nonce="${nonce}"`);
}

function servePage(req, res) {
  const nonce = crypto.randomBytes(16).toString('base64');
  let html;
  try { html = renderPage(nonce); } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); logInternal('UI files missing', e.message); res.end('Code Studio could not load its interface files. Re-extract the package and start it again.'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(html);
}

// ---------------------------------------------------------------- API handlers
async function handleCompile(form) {
  const lang = form.get('lang') || 'java';
  if (!LANGS[lang]) throw Object.assign(new Error('Unknown language.'), { status: 400 });
  if (compiling) throw Object.assign(new Error('A compilation is already running.'), { status: 409 });
  const count = Number(form.get('count'));
  if (!Number.isInteger(count) || count < 1 || count > 40) throw Object.assign(new Error('Add between 1 and 40 source files.'), { status: 400 });
  const files = {};
  for (let i = 0; i < count; i++) {
    const name = form.get(`name${i}`);
    if (name === null || Object.hasOwn(files, name)) throw Object.assign(new Error('Invalid or duplicate file name.'), { status: 400 });
    files[name] = form.get(`source${i}`) || '';
  }
  const mainClass = (form.get('mainClass') || '').trim();
  const entry = (form.get('entry') || '').trim();
  if (lang === 'java' && !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(mainClass)) throw Object.assign(new Error('Enter a valid main class, such as Main or demo.Main.'), { status: 400 });
  if (lang === 'python' && !entry) throw Object.assign(new Error('Choose an entry file.'), { status: 400 });

  stopCurrent('replaced');
  cleanWorkspace(build && build.ws); build = null;
  const dir = path.join(root, `ws-${++counter}`);
  const ws = { dir, rootDir: root, srcDir: path.join(dir, 'src'), buildDir: path.join(dir, 'build'), registry: new Set() };
  fs.mkdirSync(ws.srcDir, { recursive: true });
  compiling = { ws, cancelled: false };
  let result;
  try {
    result = await compile(tools, { lang, files, mainClass, entry, std: form.get('std') || '', sanitize: form.get('sanitize') === '1' }, ws);
  } catch (e) {
    if (!e.user) logInternal('compile failed', e.stack || e.message);
    result = { success: false, diagnostics: [{ kind: 'ERROR', source: '', line: 0, column: 0, message: e.user ? e.message : GENERIC_ERROR }], trace: [], lang };
  }
  const cancelled = compiling.cancelled;
  compiling = null;
  if (cancelled) result = { success: false, cancelled: true, diagnostics: [{ kind: 'NOTE', source: '', line: 0, column: 0, message: 'Compilation stopped.' }], trace: [], lang };
  const scrub = makeScrubber(ws);
  result.diagnostics = (result.diagnostics || [])
    .filter((d) => !(d.kind === 'NOTE' && !d.line && !d.source)) // location-less notes are compiler chatter
    .map((d) => {
      if (d.internal) { logInternal('compiler helper', d.detail); return { kind: 'ERROR', source: '', line: 0, column: 0, message: GENERIC_ERROR }; }
      const out = { ...d, message: scrub(d.message), source: scrub(d.source) };
      if (d.context) out.context = scrub(d.context);
      return out;
    });
  if (result.runError) result.runError = scrub(result.runError);
  build = { ws, lang, run: result.success ? result.run : null, runError: result.runError || '', scrub };
  const { run: _run, ...publicResult } = result;
  return publicResult;
}

function handleRun(form) {
  if (!build || !build.run) {
    throw Object.assign(new Error(build && build.runError ? build.runError : 'Compile the program successfully before running it.'), { status: 400 });
  }
  if (form.get('lang') && form.get('lang') !== build.lang) throw Object.assign(new Error('The compiled program belongs to another language. Compile again.'), { status: 409 });
  stopCurrent('replaced');
  const desc = build.run;
  const run = { child: null, chunks: [], bytes: 0, done: false, exitCode: null, signal: null, stopped: false, timedOut: false, truncated: false, filter: desc.filter, filterDone: false, fbuf: '', timer: null };
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  const push = (stream, text) => {
    if (!text) return;
    if (run.filter === 'java' && stream === 'err' && !run.filterDone) {
      // The JVM may print "Picked up JAVA_TOOL_OPTIONS: ..." first; hold the start of stderr until the line is complete.
      run.fbuf += text;
      const prefix = 'Picked up ';
      if (run.fbuf.length < prefix.length && prefix.startsWith(run.fbuf)) return;
      if (run.fbuf.startsWith(prefix)) {
        let rest = run.fbuf;
        while (rest.startsWith(prefix)) {
          const nl = rest.indexOf('\n');
          if (nl < 0) return;
          rest = rest.slice(nl + 1);
        }
        text = rest;
      } else text = run.fbuf;
      run.filterDone = true; run.fbuf = '';
      if (!text) return;
    }
    if (run.bytes >= MAX_OUTPUT) return;
    text = build && build.scrub ? build.scrub(text) : text;
    run.bytes += Buffer.byteLength(text);
    run.chunks.push({ s: stream, t: text });
    if (run.bytes >= MAX_OUTPUT && !run.truncated) {
      run.truncated = true;
      run.chunks.push({ s: 'sys', t: '\n[Output limit of 2 MB reached — the program was stopped.]\n' });
      killTree(run.child);
    }
  };
  let child;
  try {
    child = spawn(desc.cmd, desc.args, { cwd: desc.cwd, env: desc.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
  } catch (e) {
    logInternal('could not start program', e.message);
    throw Object.assign(new Error('The program could not be started. Compile it again and retry.'), { status: 500 });
  }
  run.child = child;
  child.stdout.on('data', (d) => push('out', decoders.out.write(d)));
  child.stderr.on('data', (d) => push('err', decoders.err.write(d)));
  child.stdin.on('error', () => { /* the program closed its input */ });
  child.on('error', (e) => { logInternal('program error', e.message); run.chunks.push({ s: 'sys', t: 'The program could not be started. Compile it again and retry.\n' }); run.done = true; run.exitCode = -1; });
  child.on('close', (code, signal) => {
    if (run.filter === 'java' && !run.filterDone && run.fbuf) { run.filterDone = true; const rest = run.fbuf.replace(/^(Picked up [^\n]*(\n|$))+/, ''); run.fbuf = ''; push('err', rest); }
    push('out', decoders.out.end()); push('err', decoders.err.end());
    clearTimeout(run.timer);
    run.done = true; run.exitCode = code; run.signal = signal;
  });
  run.timer = setTimeout(() => { run.timedOut = true; killTree(child); }, RUN_LIMIT_MS);
  current = run;
  return { started: true };
}

function handlePoll() {
  if (!current) return { output: [], running: false, exitCode: null };
  const r = current;
  const output = r.chunks.splice(0, r.chunks.length);
  return {
    output, running: !r.done, exitCode: r.exitCode, signal: r.signal,
    stopped: r.stopped, timedOut: r.timedOut, truncated: r.truncated,
  };
}

function handleInput(form) {
  if (!current || current.done) throw Object.assign(new Error('No program is running.'), { status: 409 });
  const text = (form.get('input') || '').replace(/\r\n?/g, '\n');
  current.child.stdin.write(`${text}\n`);
  return { ok: true };
}

function handleFinishInput() {
  if (!current || current.done) throw Object.assign(new Error('No program is running.'), { status: 409 });
  current.child.stdin.end();
  return { ok: true };
}

function handleStop() {
  if (compiling) {
    compiling.cancelled = true;
    for (const child of compiling.ws.registry) killTree(child);
  }
  stopCurrent('user');
  return { ok: true };
}

async function handleStatus(refresh) {
  if (refresh || !tools) tools = await detectAll();
  const ready = Object.values(tools).some((t) => t.ready);
  return {
    ready, bridge: VERSION, platform: process.platform,
    tools: Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, publicTool(v)])),
  };
}

// ---------------------------------------------------------------- server
const POST_ROUTES = {
  '/api/compile': handleCompile, '/api/run': handleRun, '/api/poll': handlePoll,
  '/api/input': handleInput, '/api/finish-input': handleFinishInput, '/api/stop': handleStop,
};

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req) || !originOk(req)) { json(res, 403, { error: 'Forbidden host or origin.' }); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { servePage(req, res); return; }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Not found.' }); return; }
    if (!tokenOk(req)) { json(res, 401, { error: 'Missing or invalid session token. Reload the page from the launcher.' }); return; }
    if (req.method === 'GET' && url.pathname === '/api/status') { json(res, 200, await handleStatus(url.searchParams.get('refresh') === '1')); return; }
    const handler = POST_ROUTES[url.pathname];
    if (req.method !== 'POST' || !handler) { json(res, 404, { error: 'Not found.' }); return; }
    const form = await readBody(req);
    json(res, 200, await handler(form));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) logInternal('request failed', e.stack || e.message);
    json(res, status, { error: status >= 500 ? GENERIC_ERROR : e.message });
  }
});

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => { /* no browser launcher; the address is printed below */ });
    p.unref();
  } catch { /* ignore */ }
}

function listen(attempt) {
  port = BASE_PORT + attempt;
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) listen(attempt + 1);
    else { console.error(`Could not start the bridge: ${e.message}`); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  Code Studio is running at ${url}\n  Keep this window open while you use the IDE. Press Ctrl+C to quit.\n`);
    openBrowser(url);
  });
}

function shutdown() {
  stopCurrent('exit');
  if (compiling) for (const c of compiling.ws.registry) killTree(c);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);
// When the desktop app owns this process, exit (and stop any running program) as soon as it closes our stdin.
if (process.argv.includes('--exit-with-parent')) {
  process.stdin.on('end', () => { shutdown(); process.exit(0); });
  process.stdin.on('error', () => { shutdown(); process.exit(0); });
  process.stdin.resume();
}

(async () => {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error(`Node.js 18 or newer is required (found ${process.version}).`);
    process.exit(1);
  }
  console.log('Code Studio — looking for installed compilers…');
  tools = await detectAll();
  const line = (label, t) => console.log(`  ${t.ready ? '[ok]  ' : '[missing]'} ${label.padEnd(8)} ${t.ready ? `${t.name} ${t.version}` : `${t.detail}${t.hint ? `  ->  ${t.hint}` : ''}`}`);
  line('Java', tools.java); line('C', tools.c); line('C++', tools.cpp); line('Python', tools.python);
  listen(0);
})();
