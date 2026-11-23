'use strict';
// Small, cross-platform process helpers: run a tool to completion, kill a whole process tree.
const { spawn } = require('node:child_process');

const isWin = process.platform === 'win32';
const MAX_CAPTURE = 8 * 1024 * 1024;

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (isWin) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* process already finished */ }
}

/** Run a command to completion. Never rejects; inspect {code, stdout, stderr, timedOut, error}. */
function runTool(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    const out = []; const err = [];
    let size = 0; let done = false; let timedOut = false; let timer = null;
    const finish = (extra) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (opts.registry) opts.registry.delete(child);
      resolve({
        code: null, signal: null, error: null,
        ...extra,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    };
    const collect = (bucket) => (chunk) => { size += chunk.length; if (size <= MAX_CAPTURE) bucket.push(chunk); };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (error) => finish({ code: -1, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', () => { /* tool exited before reading stdin */ });
    child.stdin.end(opts.input || '');
    if (opts.registry) opts.registry.add(child);
    if (opts.timeout) timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeout);
  });
}

module.exports = { runTool, killTree, isWin };
