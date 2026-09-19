/**
 * Socket.IO, attached to the HTTP server the process already runs.
 *
 * Lives here rather than in `server.ts` so that file stays what it claims to be
 * — connect, listen, drain, exit — and so the socket auth rule is stated beside
 * the code that depends on it rather than buried in a bootstrap.
 *
 * ## Rooms derive from the AUTHENTICATED user, never from the client
 *
 * `authSocket()` is `@oxy.so/core`'s own handshake verifier, the socket
 * equivalent of `createOxyAuthMiddleware`. A connection that does not carry a
 * valid Oxy session never reaches `connection`, and the room name is built from
 * the id the handshake resolved. A room name taken from a client-supplied value
 * is a subscription to somebody else's events.
 */

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { config } from './config';
import { oxyClient } from './middleware/auth';

type AuthedSocket = Socket & { user?: { id: string } };

/** Attach the realtime surface. Returns the server so shutdown can close it. */
export function attachRealtime(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    // Socket.IO does its own origin check, so it needs the same list the HTTP
    // side gets from `createOxyCors` — read from config, never hardcoded.
    cors: {
      origin: [...config.corsAppOrigins],
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.use(oxyClient.authSocket());
  io.on('connection', (socket: AuthedSocket) => {
    const userId = socket.user?.id;
    if (!userId) {
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${userId}`);
    socket.on('disconnect', () => socket.leave(`user:${userId}`));
  });

  return io;
}
