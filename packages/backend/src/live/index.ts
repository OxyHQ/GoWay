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
import { type LiveBus, ValkeyLiveBus } from './cluster';
import { packLivePayload } from './pack';
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
  /**
   * The bus shared with the other API tasks. Default: Valkey at
   * `config.valkeyUrl` when set, else none (this process polls alone).
   */
  bus?: LiveBus | null;
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

/** `null` when `LIVE_SOURCES` lists nothing, or no listed source survived configuration. */
export function createLiveService(options: CreateLiveServiceOptions): LiveService | null {
  const { config, logger } = options;
  if (config.sources.length === 0) return null;
  const sources = configuredLiveSources(config, logger);
  if (sources.length === 0) {
    logger.warn({}, 'No listed live source is usable; live stays off');
    return null;
  }
  if (config.valkeyUrlProblem && options.bus === undefined) {
    // Never the value: it may carry a password.
    logger.warn(
      { problem: config.valkeyUrlProblem },
      'Live runs without a shared bus: every task polls on its own',
    );
  }
  let namespace: Namespace | null = null;
  const bus =
    options.bus !== undefined
      ? options.bus
      : config.valkeyUrl
        ? ValkeyLiveBus.fromUrl(config.valkeyUrl)
        : null;
  const hub = new LiveHub({
    bus,
    sources,
    fetch: options.fetch ?? (globalThis.fetch as unknown as LiveFetch),
    ...(options.now ? { now: options.now } : {}),
    logger,
    publish: (delta: LiveDelta) => {
      // Packed once per room, whoever is in it.
      namespace
        ?.to(liveRoomName(delta.tile, delta.kind))
        .emit(LIVE_SOCKET_EVENTS.delta, packLivePayload(delta));
    },
    onSourcesChanged: () => {
      namespace?.emit(
        LIVE_SOCKET_EVENTS.sources,
        packLivePayload({ items: hub.sources(), nextCursor: null }),
      );
    },
  });
  logger.info(
    {
      sources: sources.map((source) => source.definition.id),
      // Never the URL: it may carry credentials.
      shared: bus !== null,
      ...(bus ? { task: bus.taskId } : {}),
    },
    'Live layer configured',
  );
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
