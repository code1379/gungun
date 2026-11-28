// The inherited pipe closes on Electron exit, including SIGKILL. Never detach the core.
const { spawn } = require('node:child_process');
const core = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  core.kill('SIGTERM');
  setTimeout(() => core.kill('SIGKILL'), 2000).unref();
}
process.stdin.resume();
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
core.on('error', () => process.exit(1));
core.on('exit', code => process.exit(code ?? 1));
