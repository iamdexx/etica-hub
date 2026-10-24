import copy
import json
import tempfile
import unittest
from pathlib import Path
from package import build
from publish import (
    load_package,
    publish_one,
    verify_remote,
    matches_source,
    atomic_json,
    file_md5,
    Zenodo,
)
from test_package import record


class FakeZenodo:
    def __init__(self, package):
        self.package = package
        self.calls = []
        self.dep = None
        self.fail_create = False
        self.fail_publish = False
        self.existing = []

    def request(self, method, path, data=None, binary=False):
        self.calls.append((method, path))
        if path.startswith("/deposit/depositions?page="):
            return self.existing
        if method == "POST" and path == "/deposit/depositions":
            if self.fail_create:
                raise TimeoutError("ambiguous create")
            self.dep = {
                "id": 99,
                "files": [],
                "metadata": data["metadata"],
                "submitted": False,
                "state": "unsubmitted",
                "links": {"bucket": "https://zenodo.org/api/files/bucket"},
            }
        elif method == "PUT" and "/api/files/bucket/" in path:
            name = path.rsplit("/", 1)[-1]
            self.dep["files"].append(
                {
                    "filename": name,
                    "checksum": file_md5(self.package["directory"] / name),
                    "id": name,
                }
            )
        elif method == "DELETE":
            self.dep["files"] = [
                f for f in self.dep["files"] if f["id"] != path.rsplit("/", 1)[-1]
            ]
        elif method == "PUT":
            self.dep["metadata"] = data["metadata"]
        elif method == "POST" and path.endswith("/actions/publish"):
            if self.fail_publish:
                raise TimeoutError("ambiguous publish")
            self.dep.update(submitted=True, state="done", doi="10.5281/zenodo.99")
        return copy.deepcopy(self.dep)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        source = self.path / "record.json"
        source.write_text(json.dumps(record()))
        build(
            source, {"root": {"submitterTag": "autopilot-seed"}}, self.path / "package"
        )
        self.package = load_package(self.path / "package")
        self.client = FakeZenodo(self.package)
        self.ledger = {}
        self.snapshots = []

    def save(self):
        self.snapshots.append(copy.deepcopy(self.ledger))
        atomic_json(self.path / "ledger.json", self.ledger)

    def run_publish(self, **kwargs):
        return publish_one(self.client, self.package, self.ledger, self.save, **kwargs)

    def test_publish_and_idempotent_resume(self):
        result = self.run_publish()
        self.assertEqual(result["phase"], "published")
        self.assertEqual(self.snapshots[0]["a-archive"]["phase"], "creating")
        self.assertEqual(self.snapshots[-2]["a-archive"]["phase"], "publishing")
        self.run_publish()
        creates = [
            x for x in self.client.calls if x == ("POST", "/deposit/depositions")
        ]
        self.assertEqual(len(creates), 1)
        self.assertEqual(
            sum(
                path.endswith("/actions/publish") for method, path in self.client.calls
            ),
            1,
        )

    def test_ambiguous_create_never_duplicates(self):
        self.client.fail_create = True
        with self.assertRaises(TimeoutError):
            self.run_publish()
        self.client.fail_create = False
        with self.assertRaisesRegex(ValueError, "Unresolved create intent"):
            self.run_publish()
        self.assertEqual(
            sum(path == "/deposit/depositions" for method, path in self.client.calls), 1
        )

    def test_ambiguous_publish_does_not_resubmit(self):
        self.client.fail_publish = True
        with self.assertRaises(TimeoutError):
            self.run_publish()
        self.client.fail_publish = False
        with self.assertRaisesRegex(ValueError, "outcome unresolved"):
            self.run_publish()
        self.client.dep.update(submitted=True, state="done", doi="10.5281/zenodo.99")
        self.assertEqual(self.run_publish()["phase"], "published")

    def test_remote_missing_file_or_changed_metadata_is_blocked(self):
        self.run_publish()
        dep = copy.deepcopy(self.client.dep)
        dep["files"].pop()
        with self.assertRaisesRegex(ValueError, "checksums"):
            verify_remote(self.package, dep)
        dep = copy.deepcopy(self.client.dep)
        dep["metadata"]["license"] = "cc-zero"
        with self.assertRaisesRegex(ValueError, "metadata"):
            verify_remote(self.package, dep)

    def test_local_tamper_or_extra_file_is_blocked(self):
        extra = self.package["directory"] / "extra.key"
        extra.write_text("not uploaded")
        with self.assertRaisesRegex(ValueError, "Unmanifested"):
            load_package(self.package["directory"])
        extra.unlink()
        (self.package["directory"] / "report.pdf").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "integrity"):
            load_package(self.package["directory"])

    def test_duplicate_remote_source_is_blocked_before_create(self):
        self.client.existing = [{"metadata": self.package["metadata"]}]
        self.assertTrue(matches_source(self.client.existing[0], self.package["id"]))
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_publish()
        self.assertFalse(self.ledger)

    def test_adoption_requires_exact_source(self):
        self.client.dep = {"id": 99, "files": [], "submitted": False}
        with self.assertRaisesRegex(ValueError, "exact source"):
            self.run_publish(adopt=99)

    def test_draft_replacement_requires_opt_in(self):
        self.client.dep = {
            "id": 99,
            "files": [
                {
                    "filename": "record.json",
                    "id": "record",
                    "checksum": file_md5(self.package["directory"] / "record.json"),
                },
                {"filename": "old.txt", "id": "old", "checksum": "other"},
            ],
            "metadata": {},
            "submitted": False,
            "state": "unsubmitted",
            "links": {"bucket": "https://zenodo.org/api/files/bucket"},
        }
        with self.assertRaisesRegex(ValueError, "replace-draft"):
            self.run_publish(adopt=99)
        self.assertEqual(self.run_publish(replace_draft=True)["phase"], "published")

    def test_package_change_blocks_resume(self):
        self.run_publish()
        self.package["fingerprint"] = "changed"
        with self.assertRaisesRegex(ValueError, "Package changed"):
            self.run_publish()

    def test_credential_host_guard(self):
        client = Zenodo("test-only")
        for url in [
            "https://evil.example/api/",
            "https://zenodo.org@evil.example/api/",
            "https://zenodo.org/not-api",
        ]:
            with self.assertRaises(ValueError):
                client.request("GET", url)


if __name__ == "__main__":
    unittest.main()
