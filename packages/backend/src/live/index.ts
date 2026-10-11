/**
 * GoWay Live, assembled: the hub over the configured sources, and its
 * Socket.IO namespace. `server.ts` builds it (or not), starts it after
 * `listen` and stops it on shutdown; `createApp` and `attachRealtime` only
 * receive it. Nothing here runs at import.
 */

import { LIVE_SOCKET_EVENTS, type LiveDelta } from '@goway/contracts';
import type { Namespace, Server as SocketIOServer } from 'socket.io';
import type { LiveConfig } from '../config/live';
import { liveSourceEnvName } from '../config/live';
import { LIVE_SOURCES } from './catalogue';
import { LiveHub, type LiveHubLogger, type LiveHubSource } from './hub';
import { attachLiveNamespace, liveRoomName } from './socket';
import type { LiveFetch } from './types';

export interface LiveService {
  hub: LiveHub;
  /** Attach `/live` to a Socket.IO server. Once. */
  attach(io: SocketIOServer): Namespace;
  start(): void;
  stop(): void;
}

export interface CreateLiveServiceOptions {
  config: LiveConfig;
  logger: LiveHubLogger;
  fetch?: LiveFetch;
  now?: () => number;
}

/** The hub's sources from configuration: listed, known, and keyed when they must be. */
export function configuredLiveSources(config: LiveConfig, logger: LiveHubLogger): LiveHubSource[] {
  const out: LiveHubSource[] = [];
  for (const id of config.sources) {
    const definition = LIVE_SOURCES.find((source) => source.id === id);
    if (!definition) continue;
    const settings = config.settings[id] ?? {};
    if (definition.requiresKey && !settings.key) {
      logger.warn(
        { source: id, variable: `LIVE_SOURCE_${liveSourceEnvName(id)}_KEY` },
        'Live source needs a key and has none; it stays off',
      );
      continue;
    }
    out.push({
      definition,
      settings: {
        url: settings.url ?? definition.defaultUrl,
        ...(settings.key ? { key: settings.key } : {}),
        userAgent: config.userAgent,
        maxRegionsPerPoll: config.maxRegionsPerPoll,
      },
    });
  }
  return out;
}

/** `null` when live is off (`LIVE_ENABLED`) or no source survived configuration. */
export function createLiveService(options: CreateLiveServiceOptions): LiveService | null {
  const { config, logger } = options;
  if (!config.enabled) return null;
  const sources = configuredLiveSources(config, logger);
  if (sources.length === 0) {
    logger.warn({}, 'LIVE_ENABLED is set but no live source is configured; live stays off');
    return null;
  }
  let namespace: Namespace | null = null;
  const hub = new LiveHub({
    sources,
    fetch: options.fetch ?? (globalThis.fetch as unknown as LiveFetch),
    ...(options.now ? { now: options.now } : {}),
    logger,
    publish: (delta: LiveDelta) => {
      namespace?.to(liveRoomName(delta.tile, delta.kind)).emit(LIVE_SOCKET_EVENTS.delta, delta);
    },
    onSourcesChanged: () => {
      namespace?.emit(LIVE_SOCKET_EVENTS.sources, { items: hub.sources(), nextCursor: null });
    },
  });
  logger.info({ sources: sources.map((source) => source.definition.id) }, 'Live layer configured');
  return {
    hub,
    attach(io) {
      namespace = attachLiveNamespace(io, {
        hub,
        config,
        ...(options.now ? { now: options.now } : {}),
      });
      return namespace;
    },
    start: () => hub.start(),
    stop: () => hub.stop(),
  };
}
