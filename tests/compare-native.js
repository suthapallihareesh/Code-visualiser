#!/usr/bin/env node
'use strict';
/*
 * Differential test: every program is built and run TWICE, once through Code Studio and once with the
 * plain command-line tools (javac/java, gcc, g++, python3) exactly as a terminal user would.
 * The outputs, error messages and exit statuses must be identical.
 * Run:  node tests/compare-native.js   (offline; exit code 0 = identical everywhere)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectAll } = require('../lib/detect');
const { compile } = require('../lib/compile');
const { runTool, isWin } = require('../lib/proc');
const { COMMON, DIV, STDIN, BATTERY, ENTRY } = require('./programs');

let pass = 0; let fail = 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-compare-'));
let n = 0; let tools;
const check = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };
const clean = (t) => t.replace(/^Picked up .*\n/gm, '').replace(/\r\n/g, '\n');

async function studio(lang, files, extra = {}) {
  const dir = path.join(root, `s${++n}`);
  const ws = { dir, rootDir: root, srcDir: path.join(dir, 'src'), buildDir: path.join(dir, 'build'), registry: new Set() };
  const e = ENTRY[lang];
  const r = await compile(tools, { lang, files, mainClass: e.mainClass, entry: e.entry, std: '', ...extra }, ws);
  let out = null;
  if (r.success && r.run) {
    out = await runTool(r.run.cmd, r.run.args, { cwd: r.run.cwd, env: r.run.env, input: extra.input || '', timeout: 60000 });
    out.stdout = clean(out.stdout); out.stderr = clean(out.stderr);
  }
  return { r, out };
}

/** Builds and runs with the plain tools, no Code Studio involvement. */
async function native(lang, files, input = '') {
  const dir = path.join(root, `n${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  Object.entries(files).forEach(([f, s]) => fs.writeFileSync(path.join(dir, f), s));
  const name = ENTRY[lang].name;
  let build = { code: 0, stderr: '' };
  let runCmd; let runArgs = [];
  if (lang === 'java') { build = await runTool(tools.java.javac, ['-encoding', 'UTF-8', '-d', 'out', name], { cwd: dir }); runCmd = tools.java.java; runArgs = ['-Dstdout.encoding=UTF-8', '-cp', 'out', 'Main']; } // UTF-8 console, as on any modern terminal
  else if (lang === 'c') { build = await runTool(tools.c.cmd, [name, '-o', 'prog', '-lm'], { cwd: dir }); runCmd = path.join(dir, isWin ? 'prog.exe' : 'prog'); }
  else if (lang === 'cpp') { build = await runTool(tools.cpp.cmd, [name, '-o', 'prog'], { cwd: dir }); runCmd = path.join(dir, isWin ? 'prog.exe' : 'prog'); }
  else { runCmd = tools.python.cmd; runArgs = [...tools.python.pre, name]; build = await runTool(runCmd, [...tools.python.pre, '-m', 'py_compile', name], { cwd: dir }); }
  if (build.code !== 0) return { build, out: null };
  const out = await runTool(runCmd, runArgs, { cwd: dir, input, timeout: 60000 });
  out.stdout = clean(out.stdout); out.stderr = clean(out.stderr);
  return { build, out };
}

(async () => {
  console.log('Code Studio vs. the plain command-line tools (offline)\n');
  tools = await detectAll();
  const langs = ['java', 'c', 'cpp', 'python'];
  for (const l of langs) if (!tools[l].ready) { console.log(`Cannot test: ${l} is not installed.`); process.exit(2); }

  console.log('Program output must be byte-for-byte identical');
  for (const lang of langs) {
    const files = { [ENTRY[lang].name]: BATTERY[lang] };
    const s = await studio(lang, files, { input: STDIN });
    const nat = await native(lang, files, STDIN);
    const expected = [...COMMON.slice(0, 8), DIV[lang], ...COMMON.slice(8)].join('\n');
    check(`${lang}: Code Studio stdout == plain-tool stdout == expected values`,
      s.out && nat.out && s.out.stdout === nat.out.stdout && s.out.stdout.trim() === expected, `studio=${JSON.stringify(s.out && s.out.stdout.slice(0, 80))} native=${JSON.stringify(nat.out && nat.out.stdout.slice(0, 80))}`);
    check(`${lang}: same exit status (${nat.out && nat.out.code})`, s.out && nat.out && s.out.code === nat.out.code);
  }

  console.log('\nCompile errors must be the compiler\'s own message, on the same line');
  const bad = {
    java: 'public class Main {\n    public static void main(String[] a) {\n        int ok = 1;\n        int x = "s";\n    }\n}\n',
    c: '#include <stdio.h>\nint main(void) {\n    int ok = 1;\n    int x = ;\n    return ok;\n}\n',
    cpp: '#include <iostream>\nint main() {\n    int ok = 1;\n    int x = ;\n    return ok;\n}\n',
    python: 'import sys\ndef ok():\n    return 1\ndef f(:\n    pass\n',
  };
  for (const lang of langs) {
    const files = { [ENTRY[lang].name]: bad[lang] };
    const s = await studio(lang, files);
    const nat = await native(lang, files);
    const d = s.r.diagnostics.find((x) => x.kind === 'ERROR');
    const nativeText = (nat.build.stderr || '').replace(/\s+/g, ' ');
    const msg = d ? d.message.split('\n')[0].replace(/^\w*Error: /, '').replace(/\s+/g, ' ') : '';
    check(`${lang}: Studio's error message "${msg.slice(0, 60)}" appears in the plain tool's own output`, d && nat.build.code !== 0 && nativeText.includes(msg), nativeText.slice(0, 200));
    check(`${lang}: line number ${d && d.line} appears in the plain tool's output`, d && new RegExp(`(:${d.line}[:,)]|line ${d.line})`).test(nat.build.stderr), nat.build.stderr.slice(0, 160));
  }

  console.log('\nCrashes end the same way');
  const crash = {
    java: 'public class Main { public static void main(String[] a) { int[] x = new int[1]; x[2] = 0; } }\n',
    c: 'int main(void) { volatile int *p = 0; *p = 1; return 0; }\n',
    cpp: '#include <stdexcept>\nint main() { throw std::runtime_error("boom"); }\n',
    python: 'print(1 / 0)\n',
  };
  for (const lang of langs) {
    const files = { [ENTRY[lang].name]: crash[lang] };
    const s = await studio(lang, files);
    const nat = await native(lang, files);
    const same = s.out && nat.out && s.out.code === nat.out.code && s.out.signal === nat.out.signal;
    check(`${lang}: exit status ${nat.out && (nat.out.signal || nat.out.code)} is identical`, same, `studio=${s.out && (s.out.signal || s.out.code)} native=${nat.out && (nat.out.signal || nat.out.code)}`);
    if (lang === 'java' || lang === 'python') {
      const key = lang === 'java' ? 'ArrayIndexOutOfBoundsException' : 'ZeroDivisionError';
      check(`${lang}: the real "${key}" report is shown`, s.out.stderr.includes(key) && nat.out.stderr.includes(key));
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} identical, ${fail} different`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
