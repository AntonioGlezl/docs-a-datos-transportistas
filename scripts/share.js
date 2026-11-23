// npm run share: starts the app and publishes it through a temporary Cloudflare quick tunnel.
// Ctrl+C stops both. The public URL changes on every run and dies with the tunnel.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { extractTunnelUrl, cloudflaredCandidates } from './share-lib.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const { port } = loadConfig();
const localUrl = `http://localhost:${port}`;
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}

function findCloudflared() {
  return cloudflaredCandidates().find((cmd) => {
    const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    return !probe.error && probe.status === 0;
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${localUrl}/api/schema`);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const cloudflared = findCloudflared();
if (!cloudflared) {
  console.error('No se encuentra cloudflared. Instálalo con "winget install Cloudflare.cloudflared",');
  console.error('abre una terminal nueva, o indica su ruta en CLOUDFLARED_PATH dentro de .env.');
  process.exit(1);
}

// 1. The app (same process as "npm start"; .env is already loaded by the npm script).
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, stdio: 'inherit', env: process.env });
children.push(server);
server.on('exit', (code) => {
  if (!stopping) console.error(`La app se ha detenido (código ${code}).`);
  stop(code ?? 1);
});

if (!(await waitForServer())) {
  console.error(`La app no responde en ${localUrl}. ¿Está ocupado el puerto ${port}? Prueba con otro PORT en .env.`);
  stop(1);
}

// 2. The tunnel. cloudflared logs to stderr; we only show the public URL, or the log if it fails.
console.log('Abriendo túnel de Cloudflare...');
const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(tunnel);
const log = [];
let publicUrl = null;

function onOutput(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (!line.trim()) continue;
    log.push(line);
    if (log.length > 30) log.shift();
    const url = !publicUrl && extractTunnelUrl(line);
    if (url) {
      publicUrl = url;
      console.log('\n==============================================================');
      console.log(`  URL pública: ${publicUrl}`);
      console.log('  Compártela para probar desde cualquier dispositivo.');
      console.log('  Puede tardar unos segundos en responder la primera vez.');
      console.log('  Pulsa Ctrl+C para cerrar la app y el acceso público.');
      console.log('==============================================================\n');
    }
  }
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);
tunnel.on('exit', (code) => {
  if (!stopping) {
    console.error(`El túnel se ha cerrado (código ${code}). Últimas líneas de cloudflared:`);
    console.error(log.join('\n'));
  }
  stop(code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
