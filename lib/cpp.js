'use strict';
// C and C++ pipeline: preprocess -> compile to assembly -> assemble -> link, each a separate real
// invocation of gcc/clang so the walkthrough shows what actually happened.
const fs = require('node:fs');
const path = require('node:path');
const { runTool } = require('./proc');
const { LANGS, childEnv, normalizeRel, elapsed, isWin } = require('./common');

const STARTUP_C = `#include <stdio.h>
/* Added by Code Studio: unbuffered stdio so prompts such as printf("Name: ") appear immediately. */
#if defined(__GNUC__)
__attribute__((constructor)) static void studio_unbuffer_stdio(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
}
#endif
`;

function toKind(word) {
  if (/error/.test(word)) return 'ERROR';
  if (/warning/.test(word)) return 'WARNING';
  return 'NOTE';
}

/** Parses gcc/clang diagnostics, keeping the quoted code frame as `context`. */
function parseCcOutput(text, srcDir) {
  const diags = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const m = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    if (m && m[4] === 'note' && /each undeclared identifier is reported only once|in expansion of macro|this is the location of the previous definition/.test(m[5])) { cur = null; continue; }
    if (m) {
      cur = { kind: toKind(m[4]), source: normalizeRel(srcDir, m[1]), line: Number(m[2]), column: Number(m[3]) || 0, message: m[5], context: '' };
      diags.push(cur);
      continue;
    }
    const g = /^(?:[\w+.-]+):\s*(fatal error|error|warning):\s*(.*)$/.exec(line);
    if (g) {
      if (/^collect2|ld returned/.test(line)) { cur = null; continue; }
      cur = { kind: toKind(g[1]), source: '', line: 0, column: 0, message: g[2], context: '' };
      diags.push(cur);
      continue;
    }
    if (cur && /^\s+\S/.test(line)) cur.context += `${line}\n`;
    else if (line.trim()) cur = null;
  }
  diags.forEach((d) => { d.context = d.context.replace(/\n+$/, ''); });
  return diags;
}

/** Turns raw linker output into readable diagnostics. */
function parseLinkerOutput(text) {
  const diags = [];
  const seen = new Set();
  const push = (message) => { if (!seen.has(message)) { seen.add(message); diags.push({ kind: 'ERROR', source: '(linker)', line: 0, column: 0, message }); } };
  for (const line of text.split(/\r?\n/)) {
    const u = /undefined reference to [`'\u2018]?([^'\u2019`]+)['\u2019]?/.exec(line);
    if (u) {
      const name = u[1].trim();
      push(name === 'main' || name === 'WinMain'
        ? "undefined reference to 'main' \u2014 your program needs a main() function."
        : `undefined reference to '${name}' \u2014 the function is declared and used but never defined (missing file or library?).`);
      continue;
    }
    const m = /multiple definition of [`'\u2018]?([^'\u2019`]+)['\u2019]?/.exec(line);
    if (m) { push(`multiple definition of '${m[1].trim()}' \u2014 it is defined in more than one file.`); continue; }
    if (/collect2|ld returned|in function|^\s*$|^.*\.o:\s*$/.test(line)) continue;
    if (/cannot find -l|cannot open output|Permission denied|Access is denied/i.test(line)) push(line.replace(/^.*ld(\.exe)?:\s*/, '').trim());
  }
  if (!diags.length && text.trim()) push(text.trim().split(/\r?\n/).slice(0, 8).join('\n'));
  return diags;
}

function asmFacts(asm) {
  const lines = asm.split(/\r?\n/);
  const instr = lines.filter((l) => /^\s+[a-zA-Z]/.test(l) && !/^\s+\./.test(l)).length;
  const shown = lines.filter((l) => !/^\s+\./.test(l) && !/^\s*(#|;|@)/.test(l) && l.trim());
  const snippet = shown.slice(0, 30).join('\n') + (shown.length > 30 ? '\n\u2026' : '');
  return { instr, snippet };
}

async function compileC(tools, lang, req, ws, ctx) {
  const t = tools[lang];
  const cfg = LANGS[lang];
  const std = t.standards.find((s) => s.id === req.std) || t.standards.find((s) => s.id === t.defaultStd);
  const cc = t.cmd;
  const sanitize = Boolean(req.sanitize && t.sanitize);
  const env = childEnv({ LC_ALL: 'C', LANG: 'C' }, (isWin || t.bundled) ? t.dir : '');
  const diagnostics = []; const trace = [];
  const sources = req.names.filter((n) => cfg.sources.some((e) => n.toLowerCase().endsWith(e)));
  const compilerName = `${t.name.toLowerCase() === 'gcc' ? (lang === 'c' ? 'gcc' : 'g++') : (lang === 'c' ? 'clang' : 'clang++')}`;
  ctx.compilerName = compilerName; ctx.std = std.label;

  if (!sources.length) {
    diagnostics.push({ kind: 'ERROR', source: '', line: 0, column: 0, message: `Add at least one ${lang === 'c' ? '.c' : '.cpp'} source file.` });
    return { success: false, diagnostics, trace };
  }
  fs.mkdirSync(ws.buildDir, { recursive: true });
  const sanFlags = sanitize ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
  const warn = ['-Wall', '-Wextra', '-fdiagnostics-color=never'];
  const run = (args, cwd = ws.srcDir) => runTool(cc, args, { cwd, env, timeout: 90000, registry: ws.registry });

  let ok = true;
  const objects = [];
  const perFile = await Promise.all(sources.map(async (name, i) => {
    const steps = []; const diags = [];
    const base = path.join(ws.buildDir, `u${i}`);
    const stdFlag = `-std=${std.flag}`;
    let t0 = process.hrtime.bigint();
    const pre = await run([stdFlag, '-E', name, '-o', `${base}.i`]);
    const preDiags = parseCcOutput(pre.stderr, ws.srcDir);
    if (pre.code !== 0) {
      steps.push({ phase: 'PREPROCESS', moment: 'FAILED', source: name, detail: preDiags[0] ? preDiags[0].message : 'preprocessor failed', ms: elapsed(t0), facts: {} });
      diags.push(...(preDiags.length ? preDiags : [{ kind: 'ERROR', source: name, line: 0, column: 0, message: pre.stderr.trim() || 'Preprocessing failed.' }]));
      return { steps, diags, ok: false };
    }
    let ii = '';
    try { ii = fs.readFileSync(`${base}.i`, 'utf8'); } catch { /* keep empty */ }
    const headers = [...new Set([...ii.matchAll(/^# \d+ "([^"]+)"/gm)].map((m) => m[1])
      .filter((p) => !p.startsWith('<') && normalizeRel(ws.srcDir, p) !== name).map((p) => path.basename(p)))];
    const inLines = fs.readFileSync(path.join(ws.srcDir, ...name.split('/')), 'utf8').split('\n').length;
    steps.push({ phase: 'PREPROCESS', moment: 'FINISHED', source: name, ms: elapsed(t0), detail: `${inLines} \u2192 ${ii.split('\n').length} lines`, facts: { inLines, outLines: ii.split('\n').length, headers } });

    t0 = process.hrtime.bigint();
    const comp = await run([stdFlag, '-O0', '-g', ...warn, ...sanFlags, '-S', name, '-o', `${base}.s`]);
    diags.push(...parseCcOutput(comp.stderr, ws.srcDir));
    if (comp.code !== 0) {
      if (!diags.some((d) => d.kind === 'ERROR')) diags.push({ kind: 'ERROR', source: name, line: 0, column: 0, message: comp.stderr.trim() || 'Compilation failed.' });
      const nErr = diags.filter((d) => d.kind === 'ERROR').length;
      steps.push({ phase: 'COMPILE', moment: 'FAILED', source: name, ms: elapsed(t0), detail: `${nErr} error(s)`, facts: {} });
      return { steps, diags, ok: false };
    }
    let asm = '';
    try { asm = fs.readFileSync(`${base}.s`, 'utf8'); } catch { /* keep empty */ }
    const af = asmFacts(asm);
    steps.push({ phase: 'COMPILE', moment: 'FINISHED', source: name, ms: elapsed(t0), detail: `${af.instr} assembly instructions`, facts: { asmInstr: af.instr }, snippet: af.snippet });

    t0 = process.hrtime.bigint();
    const asmRun = await run(['-c', `${base}.s`, '-o', `${base}.o`], ws.buildDir);
    if (asmRun.code !== 0) {
      diags.push({ kind: 'ERROR', source: name, line: 0, column: 0, message: asmRun.stderr.trim() || 'The assembler failed.' });
      steps.push({ phase: 'ASSEMBLE', moment: 'FAILED', source: name, ms: elapsed(t0), detail: 'assembler failed', facts: {} });
      return { steps, diags, ok: false };
    }
    const objBytes = fs.statSync(`${base}.o`).size;
    steps.push({ phase: 'ASSEMBLE', moment: 'FINISHED', source: name, ms: elapsed(t0), detail: `${objBytes} bytes of machine code`, facts: { objBytes } });
    return { steps, diags, ok: true, obj: `${base}.o` };
  }));

  perFile.forEach((r) => {
    trace.push(...r.steps); diagnostics.push(...r.diags);
    if (!r.ok) ok = false; else objects.push(r.obj);
  });
  if (!ok) return { success: false, diagnostics, trace, compilerName };

  // Startup helper (unbuffered stdio) and the final link.
  const startupSrc = path.join(ws.buildDir, 'studio_startup.c');
  fs.writeFileSync(startupSrc, STARTUP_C);
  const startupObj = path.join(ws.buildDir, 'studio_startup.o');
  const sr = await run(['-x', 'c', '-c', startupSrc, '-o', startupObj], ws.buildDir);
  const exeName = isWin ? 'program.exe' : 'program';
  const exePath = path.join(ws.buildDir, exeName);
  const linkArgs = [...objects, ...(sr.code === 0 ? [startupObj] : []), '-o', exePath, ...sanFlags];
  if (isWin) linkArgs.push('-static-libgcc', ...(lang === 'cpp' ? ['-static-libstdc++'] : []));
  linkArgs.push('-lm', ...(isWin ? [] : ['-pthread']));
  const t0 = process.hrtime.bigint();
  const link = await run(linkArgs, ws.buildDir);
  if (link.code !== 0) {
    const ld = parseLinkerOutput(`${link.stdout}\n${link.stderr}`);
    diagnostics.push(...ld);
    trace.push({ phase: 'LINK', moment: 'FAILED', source: '', ms: elapsed(t0), detail: `${ld.length} linker error(s)`, facts: {} });
    return { success: false, diagnostics, trace, compilerName };
  }
  const exeBytes = fs.statSync(exePath).size;
  trace.push({ phase: 'LINK', moment: 'FINISHED', source: exeName, ms: elapsed(t0), detail: `${exeBytes} bytes`, facts: { objects: objects.length, exeBytes } });

  const runEnv = childEnv(sanitize ? { ASAN_OPTIONS: 'color=never', UBSAN_OPTIONS: 'print_stacktrace=1:color=never' } : {}, (isWin || t.bundled) ? t.dir : '');
  return {
    success: true, diagnostics, trace, compilerName,
    run: { cmd: exePath, args: [], cwd: ws.srcDir, env: runEnv },
  };
}

module.exports = { compileC, parseCcOutput, parseLinkerOutput };
