# Per-record Zenodo datasets

Each approved EticaHub-owned archive run gets its own dataset DOI under
**CC-BY-4.0**. Creator: **Mabry, Deaven**, affiliation **EticaHub Labs**.
This is not a change to the source-code license or the website's scientific
publication gate. Weak/rejected/inconclusive runs can be archived as such;
registration on Zenodo is not scientific validation.

## Prepare and inspect

Python 3.10+ on Linux/macOS:

```sh
python3 -m venv .venv-zenodo
. .venv-zenodo/bin/activate
pip install -r apps/web/scripts/zenodo/requirements.txt
python3 apps/web/scripts/zenodo/package.py --help
python3 apps/web/scripts/zenodo/publish.py --help
python3 -m unittest discover -s apps/web/scripts/zenodo -v
```

`package.py --record <snapshot.json> --goals <private-goals.json> --output
<new-package-directory> [--pdb <predicted-export.pdb>]` creates a report,
unchanged source JSON, all candidate sequences, provenance, metadata, license
and SHA-256 manifest. Review every report before submitting irreversible
publications. Provide coordinates when available; missing exports remain
explicitly missing. Failed or incomplete archive jobs with no candidate set
cannot be represented as completed candidate datasets by this utility.

The goal input is a mapping of goal IDs to **trusted server-side** goal objects.
Public API summaries omit the source marker and cannot establish ownership.
Follow the complete parent-goal lineage. A wallet on the record or any ancestor
means community work; exclude it from this owner-only publisher. A root must
have the server-assigned `autopilot-seed` marker. Missing/cyclic ancestry remains
unknown, never silently attributed to EticaHub. Do not upload the private goal
snapshot (it can contain submitter tags); the public provenance contains only
reviewed lineage IDs and the classification basis. Root attribution does not
establish that every cited source or proposed method belongs to EticaHub.

## Publish and resume

Set `ZENODO_TOKEN` as a secret environment variable with `deposit:write` and
`deposit:actions`; `ZenodoAPI` is also accepted. Never put the token in a URL,
argument, package or ledger. Keep snapshots, packages and ledger in backed-up,
non-temporary storage **outside the repository**.

`publish.py <package-directory> --ledger <ledger.json>` is a **dry run**: it
validates local hashes, ownership and license without any API request.

Add `--publish` only after inspecting the package. Default batch limit: **1**;
`--max-records` accepts 1–5. Supplying multiple prepared package paths permits
a bounded batch. Review the initial published record before releasing the
backlog; no unattended cron or bulk-release workflow is enabled here.

To adopt an existing unpublished draft, add `--adopt <deposition-id>`. The
source record's MD5 must exactly match before any mutation. `--replace-draft`
explicitly permits removing old or mismatched draft files; never use it to
rewrite a published record. All remote file checksums and relevant metadata
are checked immediately before publication.

The ledger is atomically persisted and exclusively locked. A create intent is
written before the API call. If creation times out, **stop** and reconcile the
account's draft inventory before recording its deposition ID; do not blindly
retry creation. If publish times out, the next run can confirm an already
published record, but will not resubmit an unresolved publish action. For a
confirmed failed action only, an operator can reset that record's phase to
`staging` after inspecting Zenodo. Preserve the ledger and original package
hashes. Changed snapshots require an explicit versioning decision, not a new
duplicate DOI. No automatic retry of ambiguous state-changing requests.

Requests are paced to one per second, below Zenodo's documented authenticated
limits. HTTP errors, including 429, stop the batch and report `Retry-After`;
wait at least that long before resuming. This is API compliance, not a way to
avoid content moderation. Zenodo decides whether uploads are acceptable.

Official API and terms:
- https://developers.zenodo.org/#deposit-metadata
- https://developers.zenodo.org/#publish
- https://developers.zenodo.org/#rate-limiting
- https://about.zenodo.org/terms/
