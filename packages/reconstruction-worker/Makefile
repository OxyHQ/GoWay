# Root-level entry points: `bun run worker:setup|worker:doctor|worker:run`.
# The worker manages its own Python environment with uv; the Bun workspace
# deliberately does not try to own it.

UV ?= uv

.PHONY: setup doctor run

setup:
	$(UV) sync

doctor:
	$(UV) run goway-worker doctor

run:
	$(UV) run goway-worker run
