# GoWay: published SDK adoption

Source `90dc9d543a3553e792ae230aa51705668ee0ad1b` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"receiverFiles": 1, "receiverPassed": 1, "filteredTests": 535, "sdkImporterMembers": 3580, "bloomImporterMembers": 20940, "buildExport": "passed"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Receiver fixture runs in an isolated child with loopback-only synthetic issuer authority; no SQL fixture is required.
- Filtered tests are not full-suite acceptance; required CI remains separate. Nilo export uses independently verified existing public client configuration; GoWay registered-client provisioning remains a root operation and is not proved by export.
