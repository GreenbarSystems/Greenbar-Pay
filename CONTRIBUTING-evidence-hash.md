# The evidence-packet hash contract

The SHA-256 manifest hash on every sealed evidence packet is a cryptographic
audit-trail primitive. Auditors verify it using the open-source `gbverify`
CLI (github.com/GreenbarSystems/gbverify) without any Greenbar software or
account. That verification only works because two independent codebases —
`canonicalJsonStringify` in `src/lib/evidence/assemble.ts` and the
canonicalisation implemented in both `gbverify` CLIs — produce byte-identical
serialisations of the same manifest.

**If you break that byte-identical property, every already-sealed packet in
production becomes unverifiable.** Auditors doing a routine year-end review
see a red X on documents that were valid when sealed. This has to be
treated as a breaking change to a public API, because that's exactly what
it is.

## What counts as a change to the contract

Any edit that could alter the output of `canonicalJsonStringify` for any
input, including but not limited to:

- Changing the sortReplacer function, key iteration order, or how nested
  objects are traversed.
- Changing which primitives are strings vs numbers in an assembled
  manifest (e.g. porting an amount field from `"20108.60"` to `20108.60`).
- Adding, removing, or renaming any field emitted into the manifest.
- Adding whitespace to the JSON output, changing the JSON separators, or
  escaping non-ASCII characters differently than the current default.
- Refactoring `canonicalSha256` to use a different hash function, hex vs
  base64 encoding, or a different input encoding than UTF-8.

If you are not sure whether a change qualifies, run
`npm run verify:gbverify-drift` locally. If the hash it prints for the
fixture changes, your edit changed the contract.

## Procedure for an intentional contract change

1. Bump `schemaVersion` in `src/lib/evidence/assemble.ts` — for example,
   `evidence.v2` → `evidence.v3`. Never edit the meaning of an existing
   `schemaVersion` value.
2. Update `SUPPORTED_SCHEMA_VERSIONS` in
   `scripts/verify-gbverify-drift.ts` to include the new version.
3. Cut a matching major-version release of `gbverify` that supports the
   new `schemaVersion`. Old `gbverify` releases must continue to verify
   old packets; new releases must verify both old and new. Never remove
   support for a previously-shipped `schemaVersion`.
4. Update `EXPECTED_HASH` in `scripts/verify-gbverify-drift.ts` to the
   new value printed by the script.
5. Add a `CHANGELOG` entry under a new "Evidence-packet schema" heading
   describing what changed, why, and which `gbverify` release verifies it.

CI will refuse the PR until steps 2, 4, and any accompanying gbverify
submodule bump are all present.

## What is deliberately NOT covered by the drift check

- The **shape** of the assembled manifest — i.e. that
  `assembleEvidenceManifest` produces the same fields against the same
  database rows. That is what `src/lib/evidence/__tests__` is for.
- The **correctness** of AI outputs, risk-score weights, or LLM
  provenance metadata. Those are business-logic tests, not cryptographic
  ones.
- The `originalDocument.contentHash` (source-PDF hash). That is a
  separate SHA-256 of file bytes and is not affected by canonicalisation
  changes.

The drift check is narrow on purpose. Its only job is to catch the class
of bug that silently invalidates every previously-sealed packet.
