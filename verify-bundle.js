#!/usr/bin/env node
'use strict';
/*
 * Checks that the compilers inside ./toolchains really are the ones Code Studio uses, and that they
 * compile and run a real test program correctly. The installer build runs this before packaging.
 *
 *   Windows : Java, C, C++ and Python must all come from the bundle (the system's PATH is ignored).
 *   macOS/Linux : Java and Python must come from the bundle; C and C++ use the computer's own compiler.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.env.CODESTUDIO_TOOLCHAINS || path.join(__dirname, '..', 'toolchains'));
process.env.CODESTUDIO_TOOLCHAINS = root;
const isWin = process.platform === 'win32';
if (isWin) process.env.CODESTUDIO_ONLY_BUNDLED = '1';

const { detectAll } = require('../lib/detect');
const { compile } = require('../lib/compile');
const { runTool } = require('../lib/proc');
const { COMMON, DIV, STDIN, BATTERY, ENTRY } = require('../tests/programs');

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`); if (!ok) failed++; };
const inside = (p) => !!p && path.resolve(p).toLowerCase().startsWith(root.toLowerCase());

(async () => {
  console.log(`Verifying bundled toolchains in ${root}\n`);
  if (!fs.existsSync(path.join(root, 'manifest.json'))) { console.log('  FAIL  manifest.json is missing: run "npm run toolchains" first'); process.exit(1); }
  const tools = await detectAll();

  console.log('Where each language gets its compiler');
  check('Java is ready, is JDK 21, and comes from the bundle', tools.java.ready && tools.java.major === 21 && inside(tools.java.javac), JSON.stringify(tools.java).slice(0, 300));
  check('Python is ready, is 3.12, and comes from the bundle', tools.python.ready && /^3\.12\./.test(tools.python.version) && inside(tools.python.cmd), JSON.stringify(tools.python).slice(0, 300));
  if (isWin) {
    check('C is ready and comes from the bundle (GCC)', tools.c.ready && tools.c.kind === 'gcc' && inside(tools.c.cmd), JSON.stringify(tools.c).slice(0, 300));
    check('C++ is ready and comes from the bundle (G++)', tools.cpp.ready && tools.cpp.kind === 'gcc' && inside(tools.cpp.cmd), JSON.stringify(tools.cpp).slice(0, 300));
  } else {
    console.log(`  info  C: ${tools.c.ready ? `${tools.c.name} ${tools.c.version} (computer's own)` : 'not found on this computer'}`);
    console.log(`  info  C++: ${tools.cpp.ready ? `${tools.cpp.name} ${tools.cpp.version} (computer's own)` : 'not found on this computer'}`);
  }

  console.log('\nA real program, compiled and run, must give exactly the expected output');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-verify-'));
  let n = 0;
  try {
    for (const lang of ['java', 'c', 'cpp', 'python']) {
      if (!tools[lang].ready) { console.log(`  skip  ${lang} (not available here)`); continue; }
      const dir = path.join(tmp, `ws${++n}`);
      const ws = { dir, rootDir: tmp, srcDir: path.join(dir, 'src'), buildDir: path.join(dir, 'build'), registry: new Set() };
      const e = ENTRY[lang];
      const r = await compile(tools, { lang, files: { [e.name]: BATTERY[lang] }, mainClass: e.mainClass, entry: e.entry, std: '' }, ws);
      if (!r.success) { check(`${lang}: compiles`, false, JSON.stringify(r.diagnostics).slice(0, 400)); continue; }
      const out = await runTool(r.run.cmd, r.run.args, { cwd: r.run.cwd, env: r.run.env, input: STDIN, timeout: 120000 });
      const expected = [...COMMON.slice(0, 8), DIV[lang], ...COMMON.slice(8)].join('\n');
      check(`${lang}: output is exactly right and the program exits with 0`, out.code === 0 && out.stdout.trim() === expected, `code=${out.code}\n${out.stdout.slice(0, 300)}\n${out.stderr.slice(0, 300)}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nBundle verified');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
