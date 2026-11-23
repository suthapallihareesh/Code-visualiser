'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isWin } = require('./proc');

/** Which file types belong to each language, and which of them are compiled sources. */
const LANGS = {
  java: { exts: ['.java'], sources: ['.java'] },
  c: { exts: ['.c', '.h'], sources: ['.c'] },
  cpp: { exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h'], sources: ['.cpp', '.cc', '.cxx'] },
  python: { exts: ['.py'], sources: ['.py'] },
};

const MAX_FILES = 40;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function safeFileName(lang, name) {
  const cfg = LANGS[lang];
  if (!cfg || typeof name !== 'string' || name.length > 200) return false;
  if (!cfg.exts.some((e) => name.toLowerCase().endsWith(e))) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes(':')) return false;
  return name.split('/').every((p) => p && p !== '.' && p !== '..' && /^[A-Za-z0-9_$.-]+$/.test(p));
}

/** Writes the project into dir. Throws Error with a user-facing message when something is wrong. */
const userError = (message) => Object.assign(new Error(message), { user: true });

function writeSources(lang, dir, files) {
  const names = Object.keys(files);
  if (!names.length) throw userError('Add at least one source file.');
  if (names.length > MAX_FILES) throw userError(`A project is limited to ${MAX_FILES} files.`);
  let total = 0;
  for (const name of names) {
    if (!safeFileName(lang, name)) throw userError(`Unsupported file name "${name}".`);
    const bytes = Buffer.byteLength(files[name], 'utf8');
    if (bytes > MAX_FILE_BYTES) throw userError(`${name} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw userError('The project is larger than 2 MB.');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const target = path.join(dir, ...name.split('/'));
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) throw userError(`Unsafe path "${name}".`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[name], 'utf8');
  }
  return names.sort();
}

/** Environment for child processes; optionally puts a compiler directory first on PATH (Windows DLLs). */
function childEnv(extra = {}, prependPath = '') {
  const env = { ...process.env, ...extra };
  if (prependPath) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = `${prependPath}${path.delimiter}${env[key] || ''}`;
  }
  return env;
}

const normalizeRel = (srcDir, p) => {
  let s = String(p || '').trim();
  if (path.isAbsolute(s)) s = path.relative(srcDir, s);
  s = s.replace(/\\/g, '/').replace(/^\.\//, '');
  return s;
};

const elapsed = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;

/** Parses the JSON document printed by a helper program. */
function parseHelperJson(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

module.exports = { LANGS, safeFileName, writeSources, childEnv, normalizeRel, elapsed, parseHelperJson, isWin };
