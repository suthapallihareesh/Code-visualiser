#!/usr/bin/env node
'use strict';
/*
 * Self-check: compiles and runs the same battery of programs in Java, C, C++ and Python through the
 * exact pipelines the IDE uses, and compares every result with independently known values.
 * Run:  node tests/accuracy.js        (exit code 0 = every check passed)
 * Works fully offline.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectAll } = require('../lib/detect');
const { compile } = require('../lib/compile');
const { runTool } = require('../lib/proc');

let pass = 0; let fail = 0; const failures = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-accuracy-'));
let counter = 0;
let tools;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

async function build(req) {
  const dir = path.join(root, `ws${++counter}`);
  const ws = { dir, rootDir: root, srcDir: path.join(dir, 'src'), buildDir: path.join(dir, 'build'), registry: new Set() };
  return compile(tools, req, ws);
}
async function exec(result, input = '') {
  const r = await runTool(result.run.cmd, result.run.args, { cwd: result.run.cwd, env: result.run.env, input, timeout: 60000 });
  r.stderr = r.stderr.replace(/^Picked up .*\n/gm, '');
  return r;
}

const { COMMON, DIV, STDIN, BATTERY, ENTRY } = require('./programs');

function req(lang, files, extra = {}) {
  const e = ENTRY[lang];
  return { lang, files, mainClass: e.mainClass, entry: e.entry, std: '', ...extra };
}

async function testBattery(lang) {
  console.log(`\n[${lang}] shared battery (arithmetic, strings, sorting, floats, stdin, unicode, performance)`);
  const r = await build(req(lang, { [ENTRY[lang].name]: BATTERY[lang] }));
  check(`${lang}: compiles with no errors`, r.success, JSON.stringify(r.diagnostics).slice(0, 300));
  if (!r.success) return;
  const out = await exec(r, STDIN);
  const expected = [...COMMON.slice(0, 8), DIV[lang], ...COMMON.slice(8)].join('\n');
  const got = out.stdout.trim();
  check(`${lang}: every output line matches the expected values`, got === expected, `expected:\n${expected}\n        got:\n${got}`);
  check(`${lang}: exit code 0 and empty stderr`, out.code === 0 && out.stderr.trim() === '', `code=${out.code} stderr=${out.stderr.slice(0, 200)}`);
}

async function testCompileErrors() {
  console.log('\nCompile / syntax errors are reported on the exact line');
  const cases = {
    java: ['public class Main {', '    public static void main(String[] a) {', '        int ok = 1;', '        int x = "s";', '    }', '}'],
    c: ['#include <stdio.h>', 'int main(void) {', '    int ok = 1;', '    int x = ;', '    return ok;', '}'],
    cpp: ['#include <iostream>', 'int main() {', '    int ok = 1;', '    int x = ;', '    return ok;', '}'],
    python: ['import sys', 'def ok():', '    return 1', 'def f(:', '    pass'],
  };
  for (const lang of Object.keys(cases)) {
    const r = await build(req(lang, { [ENTRY[lang].name]: `${cases[lang].join('\n')}\n` }));
    const err = r.diagnostics.find((d) => d.kind === 'ERROR');
    check(`${lang}: fails to compile and the error points at line 4`, !r.success && err && err.line === 4, JSON.stringify(r.diagnostics[0]));
  }
  const w = await build(req('c', { 'main.c': '#include <stdio.h>\nint main(void) {\n    int unused;\n    return 0;\n}\n' }));
  check('c: unused variable is a WARNING and the program still compiles', w.success && w.diagnostics.some((d) => d.kind === 'WARNING' && d.line === 3));
  const l = await build(req('c', { 'main.c': 'int helper(void);\nint main(void) { return helper(); }\n' }));
  check('c: undefined function is reported as a linker error', !l.success && l.diagnostics.some((d) => /undefined reference to 'helper'/.test(d.message)));
}

async function testRuntimeFailures() {
  console.log('\nRuntime failures behave like the real toolchain');
  let r = await build(req('java', { 'Main.java': 'public class Main { public static void main(String[] a) { int[] x = new int[1]; x[2] = 0; } }\n' }));
  let o = await exec(r);
  check('java: ArrayIndexOutOfBoundsException -> exit 1 with stack trace', o.code === 1 && /ArrayIndexOutOfBoundsException/.test(o.stderr), `code=${o.code}`);
  r = await build(req('c', { 'main.c': 'int main(void) { volatile int *p = 0; *p = 1; return 0; }\n' }));
  o = await exec(r);
  check('c: null dereference -> killed by SIGSEGV', o.signal === 'SIGSEGV' || o.code === 139, `code=${o.code} signal=${o.signal}`);
  r = await build(req('cpp', { 'main.cpp': '#include <stdexcept>\nint main() { throw std::runtime_error("boom"); }\n' }));
  o = await exec(r);
  check('cpp: uncaught exception -> abort with message', (o.signal === 'SIGABRT' || o.code === 134) && /boom/.test(o.stderr), `code=${o.code} signal=${o.signal}`);
  r = await build(req('python', { 'main.py': 'print(1 / 0)\n' }));
  o = await exec(r);
  check('python: ZeroDivisionError -> exit 1 with traceback', o.code === 1 && /ZeroDivisionError/.test(o.stderr), `code=${o.code}`);
  const exits = {
    java: 'public class Main { public static void main(String[] a) { System.exit(3); } }\n',
    c: '#include <stdlib.h>\nint main(void) { exit(3); }\n',
    cpp: '#include <cstdlib>\nint main() { std::exit(3); }\n',
    python: 'import sys\nsys.exit(3)\n',
  };
  for (const lang of Object.keys(exits)) {
    r = await build(req(lang, { [ENTRY[lang].name]: exits[lang] }));
    o = await exec(r);
    check(`${lang}: exit code 3 is reported exactly`, o.code === 3, `code=${o.code}`);
  }
}

async function testStandards() {
  console.log('\nLanguage standards are really applied');
  const std = (lang) => tools[lang].standards.map((s) => s.id);
  const cases = [
    ['c', 'c11', '_Static_assert(1, "ok");\nint main(void) { return 0; }\n', true],
    ['c', 'c11', 'int main(void) { bool b = true; return !b; }\n', false],
    ['c', 'c23', 'int main(void) { bool b = true; return !b; }\n', true],
    ['cpp', 'c++17', 'template <class T> concept Small = sizeof(T) < 8;\nint main() { return 0; }\n', false],
    ['cpp', 'c++20', 'template <class T> concept Small = sizeof(T) < 8;\nint main() { return 0; }\n', true],
    ['cpp', 'c++20', '#include <utility>\nint main() { std::unreachable(); }\n', false],
    ['cpp', 'c++23', '#include <utility>\nint main() { if (false) std::unreachable(); return 0; }\n', true],
  ];
  for (const [lang, id, src, shouldPass] of cases) {
    if (!std(lang).includes(id)) { console.log(`  SKIP  ${lang} ${id}: not supported by this compiler`); continue; }
    const r = await build(req(lang, { [ENTRY[lang].name]: src }, { std: id }));
    check(`${lang} ${id}: ${shouldPass ? 'accepts' : 'rejects'} ${src.split('\n')[0].slice(0, 50)}`, r.success === shouldPass, JSON.stringify(r.diagnostics[0]));
  }
  const j = await build(req('java', { 'Main.java': `public class Main {
    sealed interface Shape permits Circle, Square {}
    record Circle(int r) implements Shape {}
    record Square(int s) implements Shape {}
    static String describe(Object o) {
        return switch (o) { case Circle c when c.r() > 5 -> "big circle"; case Circle c -> "circle"; case Square s -> "square"; default -> "other"; };
    }
    public static void main(String[] a) {
        var text = """
            block""";
        System.out.println(describe(new Circle(9)) + "," + describe(new Square(1)) + "," + text);
    }
}
` }));
  check('java 21: records, sealed types, pattern-matching switch and text blocks compile', j.success, JSON.stringify(j.diagnostics[0]));
  if (j.success) { const o = await exec(j); check('java 21: ... and print "big circle,square,block"', o.stdout.trim() === 'big circle,square,block', o.stdout); }
}

async function testMultiFile() {
  console.log('\nMulti-file projects');
  let r = await build({ lang: 'java', mainClass: 'demo.Main', files: {
    'demo/Main.java': 'package demo;\npublic class Main { public static void main(String[] a) { System.out.println(Helper.twice(21)); } }\n',
    'demo/Helper.java': 'package demo;\npublic class Helper { static int twice(int x) { return x * 2; } }\n' } });
  let o = r.success ? await exec(r) : { stdout: '' };
  check('java: package folders + main class demo.Main -> 42', r.success && o.stdout.trim() === '42', JSON.stringify(r.diagnostics[0]));
  r = await build({ lang: 'c', std: 'c17', files: {
    'main.c': '#include <stdio.h>\n#include "math2.h"\nint main(void) { printf("%d\\n", add(40, 2)); return 0; }\n',
    'math2.c': '#include "math2.h"\nint add(int a, int b) { return a + b; }\n', 'math2.h': 'int add(int, int);\n' } });
  o = r.success ? await exec(r) : { stdout: '' };
  check('c: two .c files + header link together -> 42', r.success && o.stdout.trim() === '42', JSON.stringify(r.diagnostics[0]));
  r = await build({ lang: 'cpp', std: 'c++20', files: {
    'main.cpp': '#include <iostream>\n#include "greet.hpp"\nint main() { std::cout << greet("Ada") << "\\n"; }\n',
    'greet.cpp': '#include "greet.hpp"\nstd::string greet(const std::string& n) { return "Hi " + n; }\n',
    'greet.hpp': '#pragma once\n#include <string>\nstd::string greet(const std::string&);\n' } });
  o = r.success ? await exec(r) : { stdout: '' };
  check('cpp: two .cpp files + header link together -> "Hi Ada"', r.success && o.stdout.trim() === 'Hi Ada', JSON.stringify(r.diagnostics[0]));
  r = await build({ lang: 'python', entry: 'main.py', files: {
    'main.py': 'from helpers import square\nprint(square(12))\n', 'helpers.py': 'def square(n):\n    return n * n\n' } });
  o = r.success ? await exec(r) : { stdout: '' };
  check('python: importing a second module -> 144', r.success && o.stdout.trim() === '144', JSON.stringify(r.diagnostics[0]));
}

async function testPromptsAndOutput() {
  console.log('\nInteractive behaviour and large output');
  const r = await build(req('c', { 'main.c': '#include <stdio.h>\nint main(void) { printf("Name: "); int c = getchar(); (void)c; return 0; }\n' }));
  // The prompt has no newline; it must reach the pipe BEFORE the program is given any input.
  const { spawn } = require('node:child_process');
  const prompt = await new Promise((resolve) => {
    const p = spawn(r.run.cmd, [], { cwd: r.run.cwd, env: r.run.env });
    let seen = '';
    p.stdout.on('data', (d) => { seen += d; if (seen.includes('Name: ')) { p.kill(); resolve(true); } });
    setTimeout(() => { p.kill(); resolve(false); }, 5000);
  });
  check('c: printf prompt without newline is visible before input is given', prompt);
  const big = await build(req('python', { 'main.py': 'for i in range(100000):\n    print(i)\n' }));
  const o = await exec(big);
  check('python: 100,000 lines of output arrive complete', o.stdout.trim().split('\n').length === 100000 && o.stdout.trim().endsWith('99999'));
  if (tools.c.sanitize) {
    const s = await build(req('c', { 'main.c': '#include <stdlib.h>\nint main(void) { int *p = malloc(4 * sizeof(int)); p[4] = 1; free(p); return 0; }\n' }, { sanitize: true }));
    const so = await exec(s);
    check('c: Memory checks catch a heap buffer overflow (AddressSanitizer)', so.code !== 0 && /AddressSanitizer/.test(so.stderr), `code=${so.code}`);
  }
}

(async () => {
  console.log('Code Studio accuracy self-check (offline)\n');
  tools = await detectAll();
  for (const l of ['java', 'c', 'cpp', 'python']) {
    console.log(`  ${tools[l].ready ? 'found  ' : 'MISSING'} ${l.padEnd(7)} ${tools[l].ready ? `${tools[l].name} ${tools[l].version}` : tools[l].detail}`);
  }
  const missing = ['java', 'c', 'cpp', 'python'].filter((l) => !tools[l].ready);
  if (missing.length) { console.log(`\nCannot test: ${missing.join(', ')} not installed.`); process.exit(2); }
  for (const lang of ['java', 'c', 'cpp', 'python']) await testBattery(lang);
  await testCompileErrors();
  await testRuntimeFailures();
  await testStandards();
  await testMultiFile();
  await testPromptsAndOutput();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log(`Failed: ${failures.join(' | ')}`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
