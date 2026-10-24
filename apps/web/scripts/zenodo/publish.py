"""Explicit, bounded Zenodo publishing with immutable packages and a durable ledger."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse, quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from package import CREATORS, LICENSE, provenance, sha, source_url

API = "https://zenodo.org/api"


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(".new")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)
    directory = os.open(str(path.parent), os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Zenodo:
    def __init__(self, token):
        self.token = token
        self.next_request = 0.0
        self.opener = build_opener(NoRedirect)

    def request(self, method, path, data=None, binary=False, raw=False):
        url = path if path.startswith("https://") else API + path
        if urlparse(url).netloc != "zenodo.org" or not urlparse(url).path.startswith(
            "/api/"
        ):
            raise ValueError("Refusing to forward credentials outside Zenodo API")
        body = (
            data
            if binary
            else (json.dumps(data).encode() if data is not None else None)
        )
        headers = {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/octet-stream"
            if binary
            else "application/json",
        }
        # Below documented authenticated limits; rate limiting is not moderation evasion.
        time.sleep(max(0, self.next_request - time.monotonic()))
        self.next_request = time.monotonic() + 1.0
        try:
            with self.opener.open(
                Request(url, data=body, headers=headers, method=method), timeout=90
            ) as response:
                payload = response.read()
                return payload if raw else (json.loads(payload) if payload else None)
        except HTTPError as exc:
            # Leave state intact. Never retry creation/publish after an ambiguous response.
            retry = exc.headers.get("Retry-After", "unspecified")
            raise RuntimeError(
                f"Zenodo HTTP {exc.code}; stopped. Retry-After: {retry}. Reconcile ledger before resuming."
            ) from None


def load_package(directory, goals):
    directory = Path(directory)
    checksum_file = directory / "SHA256SUMS"
    expected = {}
    for line in checksum_file.read_text().splitlines():
        digest, name = line.split("  ", 1)
        if (
            not re.fullmatch("[a-zA-Z0-9_.-]+", name)
            or name in expected
            or name == "SHA256SUMS"
        ):
            raise ValueError("Invalid checksum manifest")
        if not re.fullmatch("[a-f0-9]{64}", digest):
            raise ValueError("Invalid SHA-256")
        file = directory / name
        if file.is_symlink() or not file.is_file() or sha(file.read_bytes()) != digest:
            raise ValueError("Package integrity failure: " + name)
        expected[name] = digest
    actual = {p.name for p in directory.iterdir()}
    if actual != set(expected) | {"SHA256SUMS"}:
        raise ValueError("Unmanifested package files")
    required = {
        "record.json",
        "provenance.json",
        "zenodo-metadata.json",
        "report.pdf",
        "candidates.fasta",
        "LICENSE.txt",
        "README.md",
    }
    if not required <= set(expected):
        raise ValueError("Incomplete publication package")
    proof = json.loads((directory / "provenance.json").read_text())
    record = json.loads((directory / "record.json").read_text())
    meta = json.loads((directory / "zenodo-metadata.json").read_text())
    if (
        proof.get("status") != "eticahub"
        or proof.get("license") != LICENSE
        or proof.get("recordId") != record.get("id")
        or proof.get("recordSha256") != expected["record.json"]
        or record.get("submitterWallet")
        or proof.get("creators") != CREATORS
    ):
        raise ValueError("Missing approved owner provenance")
    trusted = provenance(record, goals)
    if trusted["status"] != "eticahub" or trusted["lineage"] != proof.get("lineage"):
        raise ValueError("Trusted goal lineage does not confirm EticaHub ownership")
    if (
        meta.get("license") != "cc-by-4.0"
        or meta.get("creators") != CREATORS
        or meta.get("upload_type") != "dataset"
        or meta.get("access_right") != "open"
        or {"identifier": source_url(record["id"]), "relation": "isDerivedFrom"}
        not in meta.get("related_identifiers", [])
    ):
        raise ValueError("Invalid dataset metadata")
    expected["SHA256SUMS"] = sha(checksum_file.read_bytes())
    return {
        "directory": directory,
        "id": record["id"],
        "proof": proof,
        "metadata": meta,
        "fingerprint": expected["SHA256SUMS"],
        "files": expected,
    }


def file_md5(path):
    # Zenodo's upload-integrity API uses MD5; our local manifest also uses SHA-256.
    return hashlib.md5(Path(path).read_bytes()).hexdigest()


def is_published(deposition):
    return deposition.get("submitted") is True and deposition.get("state") == "done"


def verify_remote(package, deposition):
    actual = {
        f["filename"]: f["checksum"].removeprefix("md5:") for f in deposition["files"]
    }
    expected = {
        name: file_md5(package["directory"] / name) for name in package["files"]
    }
    if actual != expected:
        raise ValueError(
            "Remote file checksums or filenames differ; refusing publication"
        )
    meta = deposition["metadata"]
    for key in sorted(set(package["metadata"]) - {"related_identifiers"}):
        if meta.get(key) != package["metadata"][key]:
            raise ValueError("Remote metadata differs: " + key)
    identifiers = meta.get("related_identifiers", [])
    if not any(
        x.get("identifier") == source_url(package["id"])
        and x.get("relation") == "isDerivedFrom"
        for x in identifiers
    ):
        raise ValueError("Remote source identifier differs")


def matches_source(deposition, record_id):
    return any(
        x.get("identifier") == source_url(record_id)
        for x in deposition.get("metadata", {}).get("related_identifiers", [])
    )


def publish_one(client, package, ledger, save, adopt=None, replace_draft=False):
    key = package["id"]
    entry = ledger.get(key)
    if entry and entry.get("fingerprint") != package["fingerprint"]:
        raise ValueError(
            "Package changed after staging; preserve original package or create an explicit new-version workflow"
        )
    if entry and not entry.get("depositionId"):
        raise ValueError(
            "Unresolved create intent. Inspect Zenodo drafts, reconcile depositionId; do not create another"
        )
    if not entry:
        if adopt:
            dep = client.request("GET", f"/deposit/depositions/{adopt}")
            if is_published(dep):
                verify_remote(package, dep)
            else:
                original = next(
                    (f for f in dep["files"] if f["filename"] == "record.json"), None
                )
                if not original or original["checksum"].removeprefix(
                    "md5:"
                ) != file_md5(package["directory"] / "record.json"):
                    raise ValueError(
                        "Adopted draft does not contain this exact source record"
                    )
        else:
            # Authenticated inventory, not eventually indexed public search. Stop rather than duplicate.
            page = 1
            while True:
                rows = client.request(
                    "GET",
                    f"/deposit/depositions?page={page}&size=100&all_versions=true",
                )
                if any(matches_source(d, key) for d in rows):
                    raise ValueError(
                        "Matching source already exists on Zenodo; reconcile ledger before continuing"
                    )
                if len(rows) < 100:
                    break
                page += 1
            entry = {"fingerprint": package["fingerprint"], "phase": "creating"}
            ledger[key] = entry
            save()
            dep = client.request(
                "POST", "/deposit/depositions", {"metadata": package["metadata"]}
            )
        entry = {
            "fingerprint": package["fingerprint"],
            "depositionId": dep["id"],
            "phase": "staging",
        }
        ledger[key] = entry
        save()
    dep = client.request("GET", f"/deposit/depositions/{entry['depositionId']}")
    if is_published(dep):
        verify_remote(package, dep)
    else:
        if dep.get("submitted"):
            raise ValueError(
                "Deposition submitted but not confirmed published; do not resubmit"
            )
        if entry.get("phase") == "publishing":
            raise ValueError(
                "Previous publish outcome unresolved. Confirm remote status before resetting phase"
            )
        files = {f["filename"]: f for f in dep["files"]}
        extras = set(files) - set(package["files"])
        changed = {
            name
            for name, f in files.items()
            if name in package["files"]
            and f["checksum"].removeprefix("md5:")
            != file_md5(package["directory"] / name)
        }
        if (extras or changed) and not replace_draft:
            raise ValueError(
                "Existing draft files differ; explicit --replace-draft required"
            )
        for name in sorted(extras | changed):
            client.request(
                "DELETE", f"/deposit/depositions/{dep['id']}/files/{files[name]['id']}"
            )
            del files[name]
        for name in sorted(package["files"]):
            if name not in files:
                client.request(
                    "PUT",
                    dep["links"]["bucket"] + "/" + quote(name),
                    (package["directory"] / name).read_bytes(),
                    binary=True,
                )
        dep = client.request(
            "PUT",
            f"/deposit/depositions/{dep['id']}",
            {"metadata": package["metadata"]},
        )
        dep = client.request("GET", f"/deposit/depositions/{dep['id']}")
        verify_remote(package, dep)
        entry["phase"] = "publishing"
        save()
        client.request("POST", f"/deposit/depositions/{dep['id']}/actions/publish")
        dep = client.request("GET", f"/deposit/depositions/{dep['id']}")
        if not is_published(dep):
            raise ValueError(
                "Publication not yet confirmed; inspect remote status before resuming"
            )
        verify_remote(package, dep)
    entry.update(
        {
            "phase": "published",
            "doi": dep.get("doi") or dep["metadata"].get("doi"),
            "url": f"https://zenodo.org/records/{dep['id']}",
        }
    )
    save()
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packages", nargs="+")
    parser.add_argument(
        "--ledger", required=True, help="Durable, backed-up path outside the repo"
    )
    parser.add_argument(
        "--publish",
        action="store_true",
        help="Without this, validate only; no network requests",
    )
    parser.add_argument(
        "--goals",
        required=True,
        help="Private trusted server-side goal snapshot used to re-check ownership",
    )
    parser.add_argument("--max-records", type=int, default=1, choices=range(1, 6))
    parser.add_argument(
        "--adopt", type=int, help="Adopt an existing draft for one exact source record"
    )
    parser.add_argument(
        "--replace-draft",
        action="store_true",
        help="Replace mismatched files in that unpublished draft",
    )
    args = parser.parse_args()
    if args.adopt and len(args.packages) != 1:
        parser.error("--adopt requires exactly one package")
    goals = json.loads(Path(args.goals).read_text())
    packages = [load_package(p, goals) for p in args.packages]
    if len({p["id"] for p in packages}) != len(packages):
        parser.error("Duplicate source records")
    if not args.publish:
        print(
            json.dumps(
                [
                    {"recordId": p["id"], "files": len(p["files"]), "mode": "dry-run"}
                    for p in packages
                ]
            )
        )
        return
    token = os.environ.get("ZENODO_TOKEN") or os.environ.get("ZenodoAPI")
    if not token:
        parser.error(
            "Set ZENODO_TOKEN (or ZenodoAPI); never pass it on the command line"
        )
    ledger_path = Path(args.ledger)
    if not ledger_path.parent.is_dir():
        parser.error("Ledger parent must exist on durable storage")
    with ledger_path.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
        client = Zenodo(token)
        count = 0
        for package in packages:
            if ledger.get(package["id"], {}).get("phase") == "published":
                if ledger[package["id"]]["fingerprint"] != package["fingerprint"]:
                    raise ValueError("Published package changed")
                continue
            if count >= args.max_records:
                break
            entry = publish_one(
                client,
                package,
                ledger,
                lambda: atomic_json(ledger_path, ledger),
                args.adopt,
                args.replace_draft,
            )
            print(json.dumps({"recordId": package["id"], **entry}), flush=True)
            count += 1
        print(
            json.dumps({"batchPublished": count, "batchLimit": args.max_records}),
            flush=True,
        )


if __name__ == "__main__":
    main()
