# GoWay receiver candidate preflight

The installed contracts/core/protocol packages were built and packed from Oxy `1b50557ccfe28b382f5b219405a616b332036d42` in an isolated worktree. Each installed file is byte-equal to its candidate tarball. These are unpublished candidates, not final registry adoption; later SDK findings still require a new freeze.

The real HTTP fixture passes three controls: missing/sessionless bearer refusal, validated owner with conflicting-claim refusal, and revocation on the next request without a cached admit. The authority response is an explicitly synthetic loopback issuer. It uses the product middleware binding (Willo uses its factory and the canonical helper), with an owned test handler and no product SQL or domain effects. Backend build/type checks pass.

Source changes are test-only. Local candidate manifests/lock are retained under inputs for reproduction and excluded from the adoption commit. Final published versions, frontend compatibility and deployment gates remain pending. See proof.json for exact source, installed package hashes, logs and initial setup failures. No scopes, grants, credentials or schemas changed.

## Probe isolation follow-up

The original focal run did not establish coexistence with other suites: their cached product config could predate a beforeAll environment change. The final test launches an owned Bun process with a minimal environment and `--no-env-file`; it never imports product modules or changes environment in the parent. The child fixes its loopback issuer before dynamic imports and rejects non-loopback fetch. One test asserts three HTTP controls, four live authority reads and two admitted fixture handlers. Both servers close in independent finally paths; the child has a 15-second timeout. `isolation/proof.json` supersedes the original harness, preserving its initial setup failures. No SQL or production authority changed.
