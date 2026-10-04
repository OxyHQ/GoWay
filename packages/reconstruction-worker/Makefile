# Root-level entry points: `bun run worker:setup|worker:doctor|worker:run`.
# The worker manages its own Python environment with uv; the Bun workspace
# deliberately does not try to own it. Extra CLI flags go through ARGS, e.g.
#   bun run worker:run -- ARGS="--max-jobs 1"

UV ?= uv
ARGS ?=

.PHONY: setup doctor run status drain test

setup:
	$(UV) sync --locked
	$(UV) run --locked goway-worker setup

doctor:
	$(UV) run --locked goway-worker doctor $(ARGS)

run:
	$(UV) run --locked goway-worker run $(ARGS)

status:
	$(UV) run --locked goway-worker status

drain:
	$(UV) run --locked goway-worker drain

test:
	$(UV) run --locked pytest -q
