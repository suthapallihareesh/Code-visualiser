'use strict';
// Compile pipelines for Java and Python (C/C++ live in cpp.js) plus the dispatcher.
const fs = require('node:fs');
const path = require('node:path');
const { runTool } = require('./proc');
const { LANGS, writeSources, childEnv, normalizeRel, elapsed, parseHelperJson, isWin } = require('./common');
const { compileC } = require('./cpp');
const { enrichTrace } = require('./explain');

const HELPERS = path.join(__dirname, '..', 'helpers');
const exe = (n) => (isWin ? `${n}.exe` : n);
const err = (message, source = '') => ({ kind: 'ERROR', source, line: 0, column: 0, message });
// Internal problems (helper crashed, no answer...) are logged for the person running the launcher, never shown in the IDE.
const internalErr = (detail) => ({ kind: 'ERROR', source: '', line: 0, column: 0, message: '', internal: true, detail: String(detail) });

// ---------------------------------------------------------------- Java
let javaHelperReady = null;
function ensureJavaHelper(tools, rootDir) {
  if (!javaHelperReady) {
    const out = path.join(rootDir, 'java-helper');
    fs.mkdirSync(out, { recursive: true });
    javaHelperReady = runTool(tools.java.javac, ['-d', out, path.join(HELPERS, 'CompileHelper.java')], { timeout: 90000 })
      .then((r) => {
        if (r.code !== 0) { javaHelperReady = null; throw Object.assign(new Error(`Could not prepare the Java compiler helper:\n${r.stderr.trim()}`), { internal: true }); }
        return out;
      });
  }
  return javaHelperReady;
}


/** Parses javac's own command-line output so messages are word-for-word what `javac` prints. */
function parseJavacOutput(text, srcDir) {
  const diags = [];
  let cur = null; let stage = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(.+?):(\d+): (error|warning|note): (.*)$/.exec(line);
    if (m) {
      cur = { kind: m[3] === 'error' ? 'ERROR' : m[3] === 'warning' ? 'WARNING' : 'NOTE', source: normalizeRel(srcDir, m[1]), line: Number(m[2]), column: 0, message: m[4], context: '' };
      diags.push(cur); stage = 1; continue;
    }
    const plain = /^(error|warning|Note): (.*)$/.exec(line);
    if (plain && !cur) { diags.push({ kind: plain[1] === 'error' ? 'ERROR' : plain[1] === 'warning' ? 'WARNING' : 'NOTE', source: '', line: 0, column: 0, message: plain[2] }); continue; }
    if (!cur || /^\d+ (errors?|warnings?)$/.test(line) || !line.trim()) { if (/^\d+ (errors?|warnings?)$/.test(line)) cur = null; continue; }
    if (stage === 1) { cur.context = line; stage = 2; continue; }
    if (stage === 2 && /^\s*\^\s*$/.test(line)) { cur.column = line.indexOf('^') + 1; cur.context += `\n${line}`; stage = 3; continue; }
    if (/^\s{2}\S/.test(line)) cur.message += `\n${line.trim()}`;
  }
  return diags;
}

async function compileJava(tools, req, ws, ctx) {
  const j = tools.java;
  const helperDir = await ensureJavaHelper(tools, ws.rootDir);
  const mainClass = req.mainClass;
  const sources = req.names.filter((n) => n.endsWith('.java'));
  const r = await runTool(j.java, ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xshare:auto', '-cp', helperDir, 'CompileHelper',
    ws.srcDir, ws.buildDir, j.release, ...sources], { cwd: ws.srcDir, timeout: 120000, registry: ws.registry });
  const data = parseHelperJson(r.stdout);
  if (!data) return { success: false, diagnostics: [internalErr(`The Java compiler did not answer.\n${r.stderr.replace(/^Picked up .*$/gm, '').trim()}`)], trace: [] };
  if (data.fatal) return { success: false, diagnostics: [internalErr(data.fatal)], trace: [] };
  const diagnostics = parseJavacOutput(data.raw, ws.srcDir);
  if (data.crash) diagnostics.push(internalErr(data.crash));
  const trace = data.trace || [];
  let runError = '';
  if (data.success) {
    const classFile = path.join(ws.buildDir, ...mainClass.split('.')) + '.class';
    if (!fs.existsSync(classFile)) {
      const names = [];
      const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
        if (d.isDirectory()) walk(path.join(dir, d.name), `${prefix}${d.name}.`);
        else if (d.name.endsWith('.class') && !d.name.includes('$')) names.push(prefix + d.name.slice(0, -6));
      });
      try { walk(ws.buildDir, ''); } catch { /* empty build */ }
      runError = `Main class "${mainClass}" was not found. Compiled classes: ${names.join(', ') || 'none'}. Set "Main class" to the class that contains main().`;
      diagnostics.push({ kind: 'WARNING', source: '', line: 0, column: 0, message: runError });
    } else {
      // Real bytecode listing from javap for the explainer.
      const javap = path.join(path.dirname(j.javac) === '.' ? '' : path.dirname(j.javac), exe('javap'));
      const jp = await runTool(javap, ['-c', '-p', '-cp', ws.buildDir, mainClass], { timeout: 20000, registry: ws.registry });
      if (jp.code === 0) {
        const lines = jp.stdout.split(/\r?\n/).filter((l) => l.trim() && !/^Picked up /.test(l));
        const snippet = lines.slice(0, 32).join('\n') + (lines.length > 32 ? '\n…' : '');
        for (let i = trace.length - 1; i >= 0; i--) {
          if (trace[i].phase === 'GENERATE' && trace[i].moment === 'FINISHED' && (trace[i].detail || '').includes(mainClass)) { trace[i].snippet = snippet; break; }
        }
      }
    }
  }
  ctx.compilerName = 'javac';
  const result = { success: Boolean(data.success), diagnostics, trace, totalMs: data.totalMs, runError, compilerName: `javac ${j.version}` };
  if (data.success && !runError) {
    result.run = {
      cmd: j.java,
      args: ['-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Xmx512m', '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-cp', ws.buildDir, mainClass],
      cwd: ws.srcDir, env: childEnv(), filter: 'java',
    };
  }
  return result;
}

// ---------------------------------------------------------------- Python
async function compilePython(tools, req, ws) {
  const p = tools.python;
  const files = req.names.filter((n) => n.endsWith('.py'));
  if (!files.includes(req.entry)) return { success: false, diagnostics: [err(`Entry file "${req.entry}" does not exist.`)], trace: [] };
  const r = await runTool(p.cmd, [...p.pre, '-X', 'utf8', '-I', path.join(HELPERS, 'pycheck.py'), ws.srcDir, ...files],
    { cwd: ws.rootDir, timeout: 60000, registry: ws.registry });
  const data = parseHelperJson(r.stdout);
  if (!data) return { success: false, diagnostics: [internalErr(`Python did not answer.\n${r.stderr.trim()}`)], trace: [] };
  const result = { success: Boolean(data.success), diagnostics: data.diagnostics, trace: data.trace, totalMs: data.totalMs, compilerName: `CPython ${p.version}` };
  if (result.success) {
    result.run = {
      cmd: p.cmd, args: [...p.pre, '-u', '-X', 'utf8', req.entry], cwd: ws.srcDir,
      env: childEnv({ PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }),
    };
  }
  return result;
}

const TRACE_TITLES = {
  java: 'REAL JAVAC CALLBACKS', c: 'REAL COMPILER STAGES', cpp: 'REAL COMPILER STAGES',
  python: 'REAL CPYTHON PHASES',
};

/** Compiles one project. `ws` = { rootDir, srcDir, buildDir, registry }. */
async function compile(tools, req, ws) {
  const lang = req.lang;
  const tool = tools[lang];
  if (!tool || !tool.ready) {
    return { success: false, diagnostics: [err(`${lang} is not available on this computer. ${tool && tool.hint ? `Install it with: ${tool.hint}` : ''}`)], trace: [] };
  }
  req.names = writeSources(lang, ws.srcDir, req.files);
  const ctx = {};
  let result;
  if (lang === 'java') result = await compileJava(tools, req, ws, ctx);
  else if (lang === 'c' || lang === 'cpp') result = await compileC(tools, lang, req, ws, ctx);
  else result = await compilePython(tools, req, ws);
  const trace = enrichTrace(lang, result.trace || [], { ...ctx, compilerName: result.compilerName || ctx.compilerName });
  return { ...result, trace, traceTitle: TRACE_TITLES[lang], lang };
}

module.exports = { compile, LANGS };
