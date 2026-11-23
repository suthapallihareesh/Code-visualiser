#!/usr/bin/env node
'use strict';
// Offline unit test for the installer's toolchain downloader: asset selection and checksum parsing.
const { targetsFor, pickAsset, hashFromSums } = require('../scripts/fetch-toolchains');

let fail = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); if (!ok) fail++; };
const assets = (names) => names.map((name) => ({ name }));

const temurin = assets([
  'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip', 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip.sha256.txt',
  'OpenJDK21U-jre_x64_windows_hotspot_21.0.9_10.zip', 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.msi',
  'OpenJDK21U-jdk_x64_linux_hotspot_21.0.9_10.tar.gz', 'OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.9_10.tar.gz',
  'OpenJDK21U-jdk_x64_mac_hotspot_21.0.9_10.tar.gz', 'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.9_10.tar.gz',
  'OpenJDK21U-jdk-sources_21.0.9_10.tar.gz', 'OpenJDK21U-debugimage_x64_linux_hotspot_21.0.9_10.tar.gz',
]);
const expectJdk = {
  'win32/x64': 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.9_10.zip',
  'linux/x64': 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.9_10.tar.gz',
  'linux/arm64': 'OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.9_10.tar.gz',
  'darwin/x64': 'OpenJDK21U-jdk_x64_mac_hotspot_21.0.9_10.tar.gz',
  'darwin/arm64': 'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.9_10.tar.gz',
};
console.log('JDK: picks the full JDK archive for each platform (not the JRE, installer, sources or debug files)');
for (const [key, want] of Object.entries(expectJdk)) {
  const [p, a] = key.split('/');
  const got = pickAsset(temurin, targetsFor(p, a).jdk);
  check(`${key} -> ${want}`, got && got.name === want, `got ${got && got.name}`);
}

const py = assets([
  'cpython-3.12.11+20250712-x86_64-pc-windows-msvc-install_only.tar.gz', 'cpython-3.12.12+20251010-x86_64-pc-windows-msvc-install_only.tar.gz',
  'cpython-3.12.12+20251010-x86_64-pc-windows-msvc-install_only_stripped.tar.gz', 'cpython-3.12.12+20251010-x86_64-pc-windows-msvc-pgo-full.tar.zst',
  'cpython-3.13.5+20251010-x86_64-pc-windows-msvc-install_only.tar.gz', 'cpython-3.11.9+20251010-x86_64-pc-windows-msvc-install_only.tar.gz',
  'cpython-3.12.12+20251010-x86_64-unknown-linux-gnu-install_only.tar.gz', 'cpython-3.12.12+20251010-x86_64-unknown-linux-musl-install_only.tar.gz',
  'cpython-3.12.12+20251010-aarch64-apple-darwin-install_only.tar.gz', 'cpython-3.12.12+20251010-x86_64-apple-darwin-install_only.tar.gz', 'SHA256SUMS',
]);
console.log('\nPython: newest 3.12 patch release, plain install_only build, right platform');
for (const [key, want] of Object.entries({
  'win32/x64': 'cpython-3.12.12+20251010-x86_64-pc-windows-msvc-install_only.tar.gz',
  'linux/x64': 'cpython-3.12.12+20251010-x86_64-unknown-linux-gnu-install_only.tar.gz',
  'darwin/arm64': 'cpython-3.12.12+20251010-aarch64-apple-darwin-install_only.tar.gz',
  'darwin/x64': 'cpython-3.12.12+20251010-x86_64-apple-darwin-install_only.tar.gz',
})) {
  const [p, a] = key.split('/');
  const got = pickAsset(py, targetsFor(p, a).python);
  check(`${key} -> ${want}`, got && got.name === want, `got ${got && got.name}`);
}

console.log('\nGCC: bundled for Windows x64 only, without the LLVM variant');
const win = assets([
  'winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r2.zip', 'winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r2.7z',
  'winlibs-x86_64-posix-seh-gcc-15.2.0-llvm-21.1.0-mingw-w64ucrt-13.0.0-r2.zip', 'winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64msvcrt-13.0.0-r2.zip',
  'winlibs-i686-posix-dwarf-gcc-15.2.0-mingw-w64ucrt-13.0.0-r2.zip',
]);
const g = pickAsset(win, targetsFor('win32', 'x64').gcc);
check('win32/x64 picks the UCRT zip without LLVM', g && g.name === 'winlibs-x86_64-posix-seh-gcc-15.2.0-mingw-w64ucrt-13.0.0-r2.zip', g && g.name);
check('linux/x64 bundles no GCC', targetsFor('linux', 'x64').gcc === null);
check('darwin/arm64 bundles no GCC', targetsFor('darwin', 'arm64').gcc === null);
check('win32/arm64 bundles no GCC', targetsFor('win32', 'arm64').gcc === null);

console.log('\nChecksums');
const h = 'a'.repeat(64); const h2 = 'b'.repeat(64);
check('reads "<hash>  <file>"', hashFromSums(`${h}  one.zip\n${h2}  two.zip\n`, 'two.zip') === h2);
check('reads "<hash> *<file>"', hashFromSums(`${h} *one.zip\n`, 'one.zip') === h);
check('finds the right file in a long list', hashFromSums(`${h}  ./a.tar.gz\n${h2}  ./b.tar.gz\n`, 'b.tar.gz') === h2);
check('returns null when the file is not listed', hashFromSums(`${h}  one.zip\n`, 'other.zip') === null);
check('upper-case hashes are normalised', hashFromSums(`${h.toUpperCase()}  one.zip\n`, 'one.zip') === h);
check('unsupported platform is rejected', (() => { try { targetsFor('freebsd', 'x64'); return false; } catch { return true; } })());

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);
