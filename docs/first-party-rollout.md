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

Release gate: this source was validated with Oxy core 7, contracts 6, protocol
1.5.1 and services 13 candidates. Adopt their published registry versions before
merging/deploying this branch. Temporary local tarball overrides are not committed.
Telemetry requires an actual infrastructure region; missing region omits only
telemetry, never user auth or the workload provider. Missing/revoked bindings are
reported and retried by the shared publisher, not interpreted as missing scopes.
