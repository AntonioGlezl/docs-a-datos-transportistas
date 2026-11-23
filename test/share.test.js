import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTunnelUrl, cloudflaredCandidates } from '../scripts/share-lib.js';

test('extractTunnelUrl finds the quick tunnel URL in cloudflared output', () => {
  const line = '2026-11-23T20:10:00Z INF |  https://brave-sun-river-kite.trycloudflare.com                            |';
  assert.equal(extractTunnelUrl(line), 'https://brave-sun-river-kite.trycloudflare.com');
});

test('extractTunnelUrl ignores lines without a tunnel URL', () => {
  assert.equal(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  assert.equal(extractTunnelUrl('INF see https://www.cloudflare.com/website-terms/'), null);
});

test('cloudflaredCandidates prefers CLOUDFLARED_PATH, then PATH, then Windows install dirs', () => {
  assert.deepEqual(cloudflaredCandidates({ CLOUDFLARED_PATH: 'D:\\tools\\cloudflared.exe' }, 'win32'), [
    'D:\\tools\\cloudflared.exe',
    'cloudflared',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ]);
  assert.deepEqual(cloudflaredCandidates({}, 'linux'), ['cloudflared']);
});
