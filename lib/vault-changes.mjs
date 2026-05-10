import { spawn } from 'node:child_process';

export function parseGitLogOutput(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([MADRC])\s+(.+)$/);
    if (m) out.push({ status: m[1], path: m[2] });
  }
  return out;
}

export function vaultChanges(projectDir) {
  return new Promise((resolve) => {
    const child = spawn('git', ['log', '--name-status', '--since=24 hours ago', '--pretty=format:'], {
      cwd: projectDir,
    });
    let stdout = '';
    let errored = false;
    child.stdout.on('data', (d) => stdout += d);
    child.on('error', () => { errored = true; resolve([]); });
    child.on('exit', (code) => {
      if (errored) return;
      if (code !== 0) return resolve([]);
      resolve(parseGitLogOutput(stdout));
    });
  });
}
