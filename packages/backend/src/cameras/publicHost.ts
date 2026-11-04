/**
 * Whether a URL may be fetched on a visitor's behalf.
 *
 * The relay fetches a camera's picture from an address a provider's catalogue
 * gave us. A catalogue is third-party data: one that names `http://169.254.169.254/`
 * or `http://localhost:5432/` would turn the relay into a probe of GoWay's own
 * network. So a host is fetched only when every address it resolves to is a
 * public one, and the check is repeated for every redirect (`relay.ts`).
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Whether an IPv4/IPv6 literal is loopback, private, link-local, unspecified, multicast or reserved. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address.toLowerCase());
  return true;
}

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateV6(address: string): boolean {
  if (address === '::' || address === '::1') return true;
  // An IPv4-mapped address (`::ffff:10.0.0.1`) is judged as the IPv4 it wraps.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  const first = Number.parseInt(address.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** The addresses of a hostname, for injection in tests. */
export type Resolver = (hostname: string) => Promise<string[]>;

const resolveAll: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

/** Throws unless `url` is http(s) on a host whose every address is public. */
export async function assertPublicUrl(url: URL, resolve: Resolver = resolveAll): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not an http(s) URL');
  if (url.username || url.password) throw new Error('URL carries credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new Error(`${host} does not resolve`);
  if (addresses.some(isPrivateAddress)) throw new Error(`${host} is not a public address`);
}
