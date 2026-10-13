/**
 * Large server → client payloads travel as gzip bytes (`LIVE_PACKED_MIN_BYTES`
 * in the contract): a dense room's snapshot is mostly repeated keys. Done
 * here, in the application, because Bun's WebSocket server does not negotiate
 * permessage-deflate. The client inflates with `unpackLivePayload`.
 */
import { gzipSync } from 'node:zlib';
import { LIVE_PACKED_MIN_BYTES } from '@goway/contracts';

/** The payload as JSON when small, else its JSON gzipped (a Socket.IO binary attachment). */
export function packLivePayload(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) < LIVE_PACKED_MIN_BYTES) return value;
  return gzipSync(Buffer.from(text), { level: 6 });
}
