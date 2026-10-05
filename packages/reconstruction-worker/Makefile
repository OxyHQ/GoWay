# Root-level entry points: `bun run worker:setup|worker:doctor|worker:run`.
# The worker manages its own Python environment with uv; the Bun workspace
# deliberately does not try to own it. Extra CLI flags go through ARGS, e.g.
#   bun run worker:run -- ARGS="--max-jobs 1"

UV ?= uv
ARGS ?=

.PHONY: setup doctor run status drain test

# fused-ssim (the `gpu` extra) compiles against the venv's torch with the
# venv's pinned CUDA toolkit, so the toolkit is installed first.
CUDA_ENV = CUDA_HOME=$(CURDIR)/.venv/lib/python3.12/site-packages/nvidia/cu13 PATH=$(CURDIR)/.venv/lib/python3.12/site-packages/nvidia/cu13/bin:$(CURDIR)/.venv/bin:$$PATH

setup:
	$(UV) sync --locked
	$(UV) run --locked goway-worker setup
	$(CUDA_ENV) $(UV) sync --locked --extra gpu

doctor:
	$(UV) run --locked --extra gpu goway-worker doctor $(ARGS)

run:
	$(UV) run --locked --extra gpu goway-worker run $(ARGS)

status:
	$(UV) run --locked --extra gpu goway-worker status

drain:
	$(UV) run --locked --extra gpu goway-worker drain

test:
	$(UV) run --locked pytest -q
