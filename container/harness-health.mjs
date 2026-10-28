import { readFileSync } from 'node:fs';
try {
  const { http } = JSON.parse(readFileSync('/data/runtime/daemon.json', 'utf8'));
  const url = new URL(http);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid discovery');
  const r = await fetch(new URL('/readyz', url), { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!r.ok) throw Error(`Not ready: ${r.status}`);
  console.log('Harness ready (provider configuration is a separate check)');
} catch (e) { console.error(e.message); process.exitCode = 1; }
