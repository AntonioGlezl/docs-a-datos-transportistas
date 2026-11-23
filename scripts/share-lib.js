// Pure helpers for scripts/share.js (kept separate so they can be unit tested).

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Returns the quick tunnel URL contained in a line of cloudflared output, or null. */
export function extractTunnelUrl(text) {
  const match = TUNNEL_URL.exec(text);
  return match ? match[0] : null;
}

/** Ordered list of cloudflared executables to try. */
export function cloudflaredCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.CLOUDFLARED_PATH) candidates.push(env.CLOUDFLARED_PATH);
  candidates.push('cloudflared');
  if (platform === 'win32') {
    // Default MSI/winget install dirs; a terminal opened before installing may not have them in PATH yet.
    candidates.push(
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
    );
  }
  return candidates;
}
