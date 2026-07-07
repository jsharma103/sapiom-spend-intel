# Minor Probes — inconclusive or low-signal experiments

One short entry per experiment that was run but did **not** produce a headline finding.
Kept so we don't re-run them and so "did you test X?" has an honest answer. Real findings
live in the numbered `experiments/NN_*.md` docs.

---

## Idempotency replay (R3) — inconclusive

**Date:** 2026-07-07 · **Cost:** ~$0.0001 (one LLM call) · **Raw:** `dryrun/r3_idempotency_result.json` · **Script:** `dryrun/r3_idempotency.js`

**Question:** the SDK stamps `X-Idempotency-Key` on writes — does a replayed request dedupe or double-process?

**Method:** wrapped `globalThis.fetch` before loading `@sapiom/fetch` to capture the SDK's wire traffic for one LLM call (the full x402 flow: auth → create → reauthorize → complete), then replayed each keyed POST byte-for-byte via raw HTTP and compared returned transaction ids.

**Result:** no double charge (money moved once). Replaying `POST /transactions` (create) with the same idempotency key returned a **new** txn id (`70b37044` → `0a5ac472`) rather than the original; `/reauthorize` returned the same txn; `/complete` correctly rejected with 400.

**Why it's not a headline:** `/reauthorize` and `/complete` target a fixed txn id in their URL, so their idempotency may come from the resource path, not the key — can't cleanly isolate key-honoring from those. Create is the one endpoint where the key is the sole dedup mechanism and it didn't dedupe, but on a single call that produced only an empty (zero-cost) phantom transaction. Precise claim: *"create does not honor the idempotency key"* — not "idempotency is broken." Low consumer impact on its own (ledger clutter, no money leak); mild interaction with the §03 double-count (extra phantom txns feed the auth-request fan-out). Not worth a full write-up unless a broader idempotency audit is done later.

**If revisited:** replay create N× and confirm N phantom txns; test whether a genuine paid call (not the 402-then-settle path) double-charges on create replay.
