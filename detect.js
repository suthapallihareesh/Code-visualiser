'use strict';
// Finds the real toolchains: first the ones shipped inside the installer (CODESTUDIO_TOOLCHAINS), then
// the ones installed on this computer. Nothing is emulated.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool, isWin } = require('./proc');

const exe = (name) => (isWin ? `${name}.exe` : name);
const stripNoise = (text) => text.split(/\r?\n/).filter((l) => !/^Picked up /.test(l)).join('\n').trim();

/** Folder holding the compilers that ship inside the installer (set by the desktop app), if any. */
function bundledRoot() {
  const r = process.env.CODESTUDIO_TOOLCHAINS;
  try { return r && fs.statSync(r).isDirectory() ? r : null; } catch { return null; }
}
/** Bundled compilers are used exclusively when this is set (used by the installer's self-check). */
const onlyBundled = () => process.env.CODESTUDIO_ONLY_BUNDLED === '1';

function dirsMatching(base, test) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && test(d.name)).map((d) => path.join(base, d.name));
  } catch { return []; }
}

/** Extra places to look for a C/C++ compiler that is installed but not on PATH (Windows mostly). */
function compilerDirs() {
  const dirs = [];
  if (isWin) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);
    dirs.push('C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', 'C:\\msys64\\clang64\\bin',
      'C:\\mingw64\\bin', 'C:\\MinGW\\bin', 'C:\\TDM-GCC-64\\bin', 'C:\\w64devkit\\bin', 'C:\\winlibs\\mingw64\\bin');
    pf.forEach((p) => dirs.push(path.join(p, 'LLVM', 'bin')));
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
      dirsMatching(pkgs, (n) => /winlibs|mingw|llvm/i.test(n)).forEach((d) => {
        dirs.push(path.join(d, 'mingw64', 'bin'), path.join(d, 'mingw32', 'bin'), path.join(d, 'bin'));
      });
    }
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  }
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

async function probe(cmd, args) {
  const r = await runTool(cmd, args, { timeout: 10000 });
  if (r.error || r.code !== 0) return null;
  return stripNoise(`${r.stdout}\n${r.stderr}`);
}

// ---------------------------------------------------------------- Java
async function detectJava() {
  const candidates = [];
  const add = (binDir) => candidates.push({
    javac: binDir ? path.join(binDir, exe('javac')) : 'javac',
    java: binDir ? path.join(binDir, exe('java')) : 'java',
  });
  const bundled = bundledRoot();
  if (bundled) add(path.join(bundled, 'jdk', 'bin'));
  if (!(bundled && onlyBundled())) {
    if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin'));
    add(null);
  }
  const homes = (bundled && onlyBundled()) ? [] : isWin
    ? ['Eclipse Adoptium', 'Java', 'Microsoft', 'Amazon Corretto', 'Zulu', 'BellSoft', 'Semeru'].flatMap((v) =>
      dirsMatching(path.join(process.env.ProgramFiles || 'C:\\Program Files', v), () => true))
    : [...dirsMatching('/usr/lib/jvm', () => true), ...dirsMatching('/Library/Java/JavaVirtualMachines', () => true)
      .map((d) => path.join(d, 'Contents', 'Home'))];
  homes.forEach((h) => add(path.join(h, 'bin')));

  const seen = new Set(); const found = [];
  for (const c of candidates) {
    if (seen.has(c.javac)) continue; seen.add(c.javac);
    const text = await probe(c.javac, ['-version']);
    const m = text && /javac\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?([\w.+-]*)/.exec(text);
    if (!m) continue;
    const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
    if (major < 17) continue;
    const runtime = await probe(c.java, ['-version']);
    if (!runtime) continue;
    found.push({ ...c, major, version: `${m[1]}${m[2] ? `.${m[2]}` : ''}${m[3] ? `.${m[3]}` : ''}` });
  }
  // JDK 21 first, then newer ones; on a tie the order found wins (bundled JDK before system ones).
  const rank = (x) => (x.major === 21 ? 1000 : x.major);
  found.forEach((f, i) => { f.order = i; });
  found.sort((a, b) => (rank(b) - rank(a)) || (a.order - b.order));
  const best = found[0];
  if (!best) {
    return {
      ready: false,
      hint: isWin ? 'winget install EclipseAdoptium.Temurin.21.JDK' : 'Install a full JDK 21, e.g. sudo apt install openjdk-21-jdk',
      detail: 'A full JDK 21 (with javac) was not found.',
    };
  }
  return {
    ready: true, name: 'OpenJDK', version: best.version, major: best.major,
    release: String(Math.min(best.major, 21)), javac: best.javac, java: best.java,
    detail: `javac ${best.version}`,
  };
}

// ---------------------------------------------------------------- C and C++
const C_STANDARDS = [
  { id: 'c11', label: 'C11', flags: ['gnu11'] },
  { id: 'c17', label: 'C17', flags: ['gnu17', 'gnu18'] },
  { id: 'c23', label: 'C23', flags: ['gnu23', 'gnu2x'] },
];
const CPP_STANDARDS = [
  { id: 'c++17', label: 'C++17', flags: ['gnu++17'] },
  { id: 'c++20', label: 'C++20', flags: ['gnu++20', 'gnu++2a'] },
  { id: 'c++23', label: 'C++23', flags: ['gnu++23', 'gnu++2b'] },
  { id: 'c++26', label: 'C++26', flags: ['gnu++26', 'gnu++2c'] },
];

async function findCompiler(names) {
  const bundled = bundledRoot();
  const bundledDirs = bundled ? [path.join(bundled, 'gcc', 'bin'), path.join(bundled, 'llvm', 'bin')] : [];
  const restricted = bundled && onlyBundled();
  const dirs = restricted ? [] : compilerDirs();
  const tried = new Set();
  const list = [...bundledDirs.flatMap((d) => names.map((n) => ({ cmd: path.join(d, exe(n)), dir: d }))),
    ...(restricted ? [] : names.map((n) => ({ cmd: n, dir: '' }))),
    ...dirs.flatMap((d) => names.map((n) => ({ cmd: path.join(d, exe(n)), dir: d })))];
  for (const c of list) {
    if (tried.has(c.cmd)) continue; tried.add(c.cmd);
    if (c.dir && !fs.existsSync(c.cmd)) continue;
    const text = await probe(c.cmd, ['--version']);
    if (!text) continue;
    const first = text.split('\n')[0];
    const kind = /clang/i.test(first) ? 'clang' : /gcc|g\+\+|GNU|Free Software/i.test(text) ? 'gcc' : null;
    if (!kind) continue; // e.g. Apple's or MSVC shims that are not usable here
    const v = /(\d+\.\d+(?:\.\d+)?)/.exec(first);
    return { cmd: c.cmd, kind, version: v ? v[1] : '', first, dir: c.dir || (path.isAbsolute(c.cmd) ? path.dirname(c.cmd) : '') };
  }
  return null;
}

async function probeStandards(compiler, lang, list) {
  const xlang = lang === 'c' ? 'c' : 'c++';
  const results = await Promise.all(list.map(async (s) => {
    for (const flag of s.flags) {
      const r = await runTool(compiler.cmd, [`-std=${flag}`, '-fsyntax-only', '-x', xlang, '-'], { input: '', timeout: 15000 });
      if (!r.error && r.code === 0) return { id: s.id, label: s.label, flag };
    }
    return null;
  }));
  return results.filter(Boolean);
}

async function probeSanitizer(compiler, lang) {
  if (isWin) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-san-'));
  try {
    const file = path.join(dir, lang === 'c' ? 't.c' : 't.cpp');
    fs.writeFileSync(file, lang === 'c' ? 'int main(void){return 0;}\n' : 'int main(){return 0;}\n');
    const out = path.join(dir, 't.out');
    const b = await runTool(compiler.cmd, ['-fsanitize=address,undefined', file, '-o', out], { timeout: 20000 });
    if (b.code !== 0) return false;
    const r = await runTool(out, [], { timeout: 10000 });
    return r.code === 0;
  } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function detectC(lang) {
  const names = lang === 'c' ? ['gcc', 'clang', 'cc'] : ['g++', 'clang++', 'c++'];
  const compiler = await findCompiler(names);
  if (!compiler) {
    const win = 'winget install BrechtSanders.WinLibs.POSIX.UCRT  (then reopen run.bat)';
    return {
      ready: false,
      hint: isWin ? win : 'sudo apt install build-essential   (or: xcode-select --install on macOS)',
      detail: `No ${lang === 'c' ? 'C' : 'C++'} compiler (GCC or Clang) was found.`,
    };
  }
  const standards = await probeStandards(compiler, lang, lang === 'c' ? C_STANDARDS : CPP_STANDARDS);
  if (!standards.length) {
    return { ready: false, hint: 'Install a newer GCC or Clang.', detail: `${compiler.first} is too old to compile modern ${lang === 'c' ? 'C' : 'C++'}.` };
  }
  const preferred = lang === 'c' ? 'c17' : 'c++20';
  return {
    ready: true, name: compiler.kind === 'clang' ? 'Clang' : 'GCC', kind: compiler.kind, version: compiler.version,
    cmd: compiler.cmd, dir: compiler.dir, standards,
    bundled: !!(bundledRoot() && compiler.dir && path.resolve(compiler.dir).startsWith(path.resolve(bundledRoot()))),
    defaultStd: (standards.find((s) => s.id === preferred) || standards[standards.length - 1]).id,
    sanitize: await probeSanitizer(compiler, lang),
    detail: compiler.first,
  };
}

// ---------------------------------------------------------------- Python
async function detectPython() {
  const bundled = bundledRoot();
  const own = bundled ? [[isWin ? path.join(bundled, 'python', 'python.exe') : path.join(bundled, 'python', 'bin', 'python3')]] : [];
  const system = isWin
    ? [['py', '-3'], ['python'], ['python3']]
    : [['python3'], ['python']];
  const candidates = bundled && onlyBundled() ? own : [...own, ...system];
  for (const [cmd, ...pre] of candidates) {
    const text = await probe(cmd, [...pre, '--version']);
    const m = text && /Python (\d+)\.(\d+)\.(\d+)/.exec(text);
    if (!m || Number(m[1]) !== 3 || Number(m[2]) < 8) continue;
    // Resolve the real interpreter so the Microsoft Store shim or py launcher quirks cannot interfere later.
    const real = await probe(cmd, [...pre, '-c', 'import sys;print(sys.executable)']);
    const exeLine = real && real.split('\n').pop().trim();
    return {
      ready: true, name: 'CPython', version: `${m[1]}.${m[2]}.${m[3]}`,
      cmd: exeLine && fs.existsSync(exeLine) ? exeLine : cmd, pre: exeLine && fs.existsSync(exeLine) ? [] : pre,
      detail: text,
    };
  }
  return {
    ready: false,
    hint: isWin ? 'winget install Python.Python.3.12' : 'sudo apt install python3',
    detail: 'Python 3.8 or newer was not found.',
  };
}

async function detectAll() {
  const [java, c, cpp, python] = await Promise.all([
    detectJava(), detectC('c'), detectC('cpp'), detectPython(),
  ]);
  return { java, c, cpp, python };
}

module.exports = { detectAll, bundledRoot };
