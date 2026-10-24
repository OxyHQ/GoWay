# Own Oxy platform access

GoWay uses the shared Oxy session and workload lanes (Oxy ADR 0049). Own
workloads use a live application/environment binding and temporary AWS role
credentials, including development/SSO roles. Application scopes and customer
API keys do not authorize internal Files reference operations.

Personal gallery files still require the initiating session, explicit ownership,
image type and public visibility. Organization membership and content roles
remain live domain checks. The durable reference outbox still uses one attempt
with a five-second timeout for adds/removes; reconciliation retains its
120-second page/commit timeout and idempotent retries.

The frontend SDK uses `createLinkedClient().fetchOptional`: public browsing stays
anonymous, while authenticated calls follow shared refresh and account/logout
fences. Development fixtures receive a signed-in boolean, never the real token;
computed routes use the same linked transport. External integrations retain the
SDK's generic token-provider option and existing user/domain authorization.

The adoption release pins published registry core7.0.0, contracts6.0.0,
protocol1.5.1 and services13.0.0. SDK0.7.1 raises its Zod4 minimum to4.6.7.
All project type checks, 275 SDK tests, 24 backend identity/reference tests
and the linked HTTP session/account-switch test passed. Temporary local tarball
overrides are not committed.
Telemetry requires an actual infrastructure region; missing region omits only
telemetry, never user auth or the workload provider. Missing/revoked bindings are
reported and retried by the shared publisher, not interpreted as missing scopes.
