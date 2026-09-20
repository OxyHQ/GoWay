# GoWay's routing engine: upstream Valhalla, plus GoWay's tiles.
#
# There is deliberately NO `RUN` step. Every layer is a COPY of data produced by
# `build-tiles.sh` onto the upstream image, which means this Dockerfile builds
# for linux/arm64 on an x86 machine with no qemu emulation at all — and Valhalla
# tiles are little-endian and architecture-independent, so tiles built on either
# serve correctly on the other.
#
# Pinned by DIGEST, not by `:latest`. An engine whose behaviour changes because
# somebody upstream pushed a tag is an engine whose routes change with no diff
# anywhere in this repository. Update it deliberately, and rebuild the tiles in
# the same commit: Valhalla's tile format is versioned, and a newer binary
# reading older tiles refuses to start.
FROM ghcr.io/valhalla/valhalla@sha256:c9c1f9e6d9bb46484b667346960d4c7e6bc0cd375f95cffedcda8567c7b9706e

# Layer order is cost order: the small files that change when the configuration
# changes go first, and the 2 GB archive goes last, so a config fix re-pushes
# kilobytes rather than the whole tile set.
COPY build/valhalla.json /data/valhalla.json
COPY build/admins.sqlite /data/admins.sqlite
COPY build/timezones.sqlite /data/timezones.sqlite
COPY build/tiles.tar /data/tiles.tar

# Valhalla's own default. `packages/backend` is handed the FULL route endpoint
# (`ROUTING_VALHALLA_URL=http://.../route`), so this port is the only part of
# the address this image decides.
EXPOSE 8002

# `/status` is the engine's own liveness answer and needs no tiles to succeed,
# which is why the ECS health check below is not what proves coverage — the
# deploy's Barcelona→Madrid probe is (scripts/check-routing.mjs).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8002/status || exit 1

# One worker thread per container, sized by the task's vCPU rather than by the
# host's core count — Valhalla reads `std::thread::hardware_concurrency()`,
# which on Fargate reports the HOST's cores, not the task's share. Left
# unpinned, a 1 vCPU task spawns dozens of threads and spends its quota on
# context switches.
CMD ["valhalla_service", "/data/valhalla.json", "1"]
