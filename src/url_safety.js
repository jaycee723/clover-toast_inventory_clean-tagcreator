import net from 'node:net';

/**
 * Checks whether an IPv4 or IPv6 address belongs to a private, loopback,
 * link-local, multicast, or reserved range that must never be contacted
 * by server-side URL fetchers (SSRF protection).
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const trimmed = ip.trim().toLowerCase();

  // Strip brackets for IPv6 literals like [::1]
  const clean = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;

  const version = net.isIP(clean);
  if (version === 4) {
    const parts = clean.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 (this network)
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a >= 224) return true; // Multicast & reserved (224.0.0.0+)
    return false;
  }

  if (version === 6) {
    if (clean === '::' || clean === '::1') return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (clean.startsWith('::ffff:')) {
      const mapped = clean.slice(7);
      if (net.isIP(mapped) === 4) {
        return isPrivateOrReservedIp(mapped);
      }
      return true;
    }
    // Unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    if (
      clean.startsWith('fc') ||
      clean.startsWith('fd') ||
      clean.startsWith('fe8') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb') ||
      clean.startsWith('ff')
    ) {
      return true;
    }
    return false;
  }

  return true;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data'
]);

/**
 * Validates that a remote image URL is safe to fetch from the server.
 * Only permits public HTTPS URLs on standard port 443 with no credentials
 * and non-private hostnames/IPs.
 *
 * @param {string} rawUrl
 * @returns {{ ok: boolean, url?: URL, error?: string }}
 */
export function validatePublicImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, error: 'Image URL is required.' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    return { ok: false, error: 'Image URL must be between 1 and 2048 characters.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS image URLs are allowed.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Credentials in image URLs are not allowed.' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { ok: false, error: 'Non-standard ports are not allowed.' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: 'Host is not allowed.' };
  }

  if (
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost') ||
    host.endsWith('.home.arpa')
  ) {
    return { ok: false, error: 'Internal hostnames are not allowed.' };
  }

  // Block raw IP literals if private/reserved, or IPv6 literals
  const strippedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(strippedHost)) {
    if (isPrivateOrReservedIp(strippedHost)) {
      return { ok: false, error: 'Private or reserved IP addresses are not allowed.' };
    }
  } else if (!host.includes('.')) {
    return { ok: false, error: 'Host must be a public domain name.' };
  }

  return { ok: true, url: parsed };
}

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif'
]);

/**
 * Normalizes and validates an HTTP Content-Type header for raster logo images.
 * Explicitly rejects SVG/HTML/XML to prevent script execution.
 *
 * @param {string|null|undefined} contentTypeHeader
 * @returns {string|null} Normalized MIME type or null if disallowed
 */
export function normalizeAllowedImageMime(contentTypeHeader) {
  if (!contentTypeHeader || typeof contentTypeHeader !== 'string') return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) return null;
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}
