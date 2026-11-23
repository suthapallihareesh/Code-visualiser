#!/usr/bin/env node
'use strict';
/*
 * Downloads the real compilers that go inside the installer and unpacks them into ./toolchains:
 *
 *   toolchains/jdk/      Eclipse Temurin JDK 21 (full JDK, JAVA_HOME layout)
 *   toolchains/python/   CPython 3.12 (python-build-standalone, "install_only")
 *   toolchains/gcc/      GCC + G++ + binutils + C runtime (Windows only: WinLibs, mingw-w64 UCRT)
 *
 * Usage:  node scripts/fetch-toolchains.js [--platform=win32|linux|darwin] [--arch=x64|arm64] [--out=toolchains]
 *
 * Everything comes from the projects' own GitHub releases, and every download is checked against the
 * SHA-256 published next to it. Set GITHUB_TOKEN to avoid API rate limits (GitHub Actions does this for you).
 *
 * macOS and Linux: Apple's licence forbids redistributing its compiler SDK, and a Linux GCC needs the
 * system C library headers, so C and C++ use the compiler already on that computer (Xcode Command Line
 * Tools on macOS, build-essential on Linux). Java and Python are bundled on every platform.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const PYTHON_MINOR = '3.12';

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** Which build of each component fits this platform. Returns null for a component that is not bundled. */
function targetsFor(platform, arch) {
  const a64 = arch === 'arm64';
  const os_ = { win32: 'windows', linux: 'linux', darwin: 'mac' }[platform];
  if (!os_ || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported platform ${platform}/${arch}`);
  const triple = {
    'win32/x64': 'x86_64-pc-windows-msvc', 'win32/arm64': 'aarch64-pc-windows-msvc',
    'linux/x64': 'x86_64-unknown-linux-gnu', 'linux/arm64': 'aarch64-unknown-linux-gnu',
    'darwin/x64': 'x86_64-apple-darwin', 'darwin/arm64': 'aarch64-apple-darwin',
  }[`${platform}/${arch}`];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    jdk: {
      repo: 'adoptium/temurin21-binaries', name: 'Eclipse Temurin JDK 21', license: 'GPL-2.0 with Classpath Exception',
      home: 'https://adoptium.net/',
      pattern: new RegExp(`^OpenJDK21U-jdk_${a64 ? 'aarch64' : 'x64'}_${os_}_hotspot_[\\w.+-]+\\.(zip|tar\\.gz)$`),
      checksum: (assets, a) => assets.find((x) => x.name === `${a.name}.sha256.txt`),
    },
    python: {
      repo: 'astral-sh/python-build-standalone', name: `CPython ${PYTHON_MINOR}`, license: 'PSF-2.0',
      home: 'https://www.python.org/',
      pattern: new RegExp(`^cpython-(${esc(PYTHON_MINOR)}\\.\\d+)\\+\\d+-${esc(triple)}-install_only\\.tar\\.gz$`),
      checksum: (assets) => assets.find((x) => x.name === 'SHA256SUMS'),
      pickBest: (matches) => matches.sort((x, y) => Number(y.name.match(/-(\d+\.\d+\.(\d+))\+/)[2]) - Number(x.name.match(/-(\d+\.\d+\.(\d+))\+/)[2]))[0],
    },
    gcc: platform === 'win32' && !a64 ? {
      repo: 'brechtsanders/winlibs_mingw', name: 'GCC (WinLibs, mingw-w64 UCRT)', license: 'GPL-3.0 with GCC Runtime Library Exception',
      home: 'https://winlibs.com/',
      pattern: /^winlibs-x86_64-posix-seh-gcc-[\d.]+-mingw-w64ucrt-[\d.]+-r\d+\.zip$/,
      checksum: (assets, a) => assets.find((x) => x.name === `${a.name}.sha256`),
    } : null,
  };
}

/** Picks the right file from a release's asset list. */
function pickAsset(assets, spec) {
  const matches = assets.filter((a) => spec.pattern.test(a.name));
  if (!matches.length) return null;
  return spec.pickBest ? spec.pickBest(matches) : matches[0];
}

/** Reads "<sha256>  <file name>" lines (SHA256SUMS or *.sha256.txt) and returns the hash for a file. */
function hashFromSums(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && (m[2] === fileName || path.basename(m[2]) === fileName)) return m[1].toLowerCase();
  }
  const only = /^([0-9a-fA-F]{64})\b/.exec(text.trim()); // a file holding just the hash
  return only && !/\s\S/.test(text.trim().slice(64)) ? only[1].toLowerCase() : null;
}

module.exports = { targetsFor, pickAsset, hashFromSums };
if (require.main !== module) return;

// ------------------------------------------------------------------ the actual download

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const platform = args.platform || process.platform;
const arch = args.arch || (process.arch === 'arm64' ? 'arm64' : 'x64');
const outDir = path.resolve(args.out || path.join(__dirname, '..', 'toolchains'));
const headers = { 'User-Agent': 'code-studio-build', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

async function withRetry(label, fn) {
  let last;
  for (let i = 1; i <= 4; i++) {
    try { return await fn(); } catch (e) { last = e; console.log(`  ${label}: attempt ${i} failed (${e.message})`); await new Promise((r) => setTimeout(r, 1500 * i)); }
  }
  throw last;
}

async function getJson(url) {
  return withRetry(url, async () => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
  });
}

/** Every asset of the newest release (a release can hold hundreds, so page through them). */
async function listAssets(repo) {
  const rel = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const assets = [];
  for (let page = 1; page < 20; page++) {
    const chunk = await getJson(`https://api.github.com/repos/${repo}/releases/${rel.id}/assets?per_page=100&page=${page}`);
    assets.push(...chunk);
    if (chunk.length < 100) break;
  }
  return { tag: rel.tag_name, assets };
}

async function download(url, file) {
  await withRetry(path.basename(file), async () => {
    const r = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'], Accept: 'application/octet-stream' } });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    await pipeline(r.body, fs.createWriteStream(file));
  });
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  if (archive.endsWith('.zip') && process.platform !== 'win32') execFileSync('unzip', ['-q', archive, '-d', into], { stdio: 'inherit' });
  else execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' }); // bsdtar on Windows reads .zip too
}

/** Finds the directory that contains bin/<tool> (JDK layouts differ between operating systems). */
function findHome(dir, tool, depth = 0) {
  if (fs.existsSync(path.join(dir, 'bin', tool))) return dir;
  if (depth > 4) return null;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { const r = findHome(path.join(dir, d.name), tool, depth + 1); if (r) return r; }
  }
  return null;
}

async function fetchComponent(key, spec, notes) {
  console.log(`\n[${key}] ${spec.name}`);
  const { tag, assets } = await listAssets(spec.repo);
  const asset = pickAsset(assets, spec);
  if (!asset) throw new Error(`No matching file in ${spec.repo} ${tag} for ${platform}/${arch}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cs-${key}-`));
  try {
    const archive = path.join(tmp, asset.name);
    console.log(`  downloading ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB) from ${spec.repo} ${tag}`);
    await download(asset.browser_download_url, archive);

    const actual = await sha256(archive);
    const sumAsset = spec.checksum(assets, asset);
    if (!sumAsset) throw new Error(`No published checksum found for ${asset.name}; refusing to use an unverified download.`);
    const sumFile = path.join(tmp, 'sum.txt');
    await download(sumAsset.browser_download_url, sumFile);
    const expected = hashFromSums(fs.readFileSync(sumFile, 'utf8'), asset.name);
    if (!expected) throw new Error(`Could not read the checksum for ${asset.name}`);
    if (expected !== actual) throw new Error(`Checksum mismatch for ${asset.name}: expected ${expected}, got ${actual}`);
    console.log(`  checksum ok (${actual.slice(0, 16)}…)`);

    const unpack = path.join(tmp, 'unpacked');
    extract(archive, unpack);
    const target = path.join(outDir, key);
    fs.rmSync(target, { recursive: true, force: true });
    const tool = key === 'jdk' ? (platform === 'win32' ? 'javac.exe' : 'javac')
      : key === 'gcc' ? (platform === 'win32' ? 'gcc.exe' : 'gcc')
      : (platform === 'win32' ? null : 'python3');
    let home;
    if (key === 'python') home = path.join(unpack, 'python');
    else home = findHome(unpack, tool);
    if (!home || !fs.existsSync(home)) throw new Error(`Unexpected archive layout for ${asset.name}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(home, target, { recursive: true, verbatimSymlinks: true });
    notes.push({ component: key, name: spec.name, version: tag, file: asset.name, sha256: actual, license: spec.license, home: spec.home, source: `https://github.com/${spec.repo}/releases/tag/${encodeURIComponent(tag)}` });
    console.log(`  installed to ${path.relative(process.cwd(), target) || target}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  console.log(`Fetching toolchains for ${platform}/${arch} into ${outDir}`);
  const t = targetsFor(platform, arch);
  const notes = [];
  fs.mkdirSync(outDir, { recursive: true });
  await fetchComponent('jdk', t.jdk, notes);
  await fetchComponent('python', t.python, notes);
  if (t.gcc) await fetchComponent('gcc', t.gcc, notes);
  else console.log(`\n[gcc] Not bundled on ${platform}/${arch}: C and C++ use the compiler installed on the computer.`);

  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ platform, arch, components: notes }, null, 2)}\n`);
  const lines = ['Code Studio ships with the following unmodified third-party software.', 'Each component keeps its own licence; the source code is available from the address given.', ''];
  notes.forEach((n) => lines.push(`${n.name}  (${n.version})`, `  Licence: ${n.license}`, `  Project: ${n.home}`, `  Source and builds: ${n.source}`, ''));
  fs.writeFileSync(path.join(outDir, 'THIRD-PARTY-NOTICES.txt'), lines.join('\n'));
  console.log('\nDone.');
})().catch((e) => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
