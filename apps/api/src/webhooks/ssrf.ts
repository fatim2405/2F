import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for outbound webhooks. A merchant chooses the URL, so in
 * production a webhook must never reach loopback, private, link-local
 * (cloud metadata) or other internal addresses. Applied both when a URL is
 * saved (literal IPs / localhost) and right before each send (after DNS
 * resolution, so a public-looking hostname that resolves inward is caught).
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** True for any address a production webhook must not be sent to. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isBlockedV4(mapped[1]!);
    return (
      ip === "::" ||
      ip === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(ip) || // fc00::/7 unique local
      /^fe[89ab][0-9a-f]:/.test(ip) // fe80::/10 link-local
    );
  }
  return false;
}

/** Save-time check: rejects localhost and literal internal IPs. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isBlockedAddress(host);
}

/** Send-time check: resolves the hostname and rejects if any address is internal. */
export async function resolvesToBlockedAddress(hostname: string): Promise<boolean> {
  if (isBlockedHostname(hostname)) return true;
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return false;
  const addresses = await lookup(host, { all: true });
  return addresses.some((a) => isBlockedAddress(a.address));
}
