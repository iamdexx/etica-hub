import json
import tempfile
import unittest
from pathlib import Path
from package import (
    build,
    limitations,
    metadata,
    provenance,
    sha,
    validate,
    validate_pdb,
)


def record():
    c = {
        "index": 0,
        "sequence": "APPDEA",
        "folded": False,
        "verification": {"grade": "rejected", "checks": []},
    }
    return {
        "id": "a-archive",
        "goalId": "root",
        "completedAt": 1700000000000,
        "prompt": "Design a disulfide staple <script>",
        "hypothesis": "Unproven",
        "candidates": [c],
        "bestCandidate": c,
        "iterations": 1,
    }


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.goals = {"root": {"submitterTag": "autopilot-seed"}}

    def test_missing_wallet_is_not_ownership(self):
        self.assertEqual(provenance(record(), {"root": {}})["status"], "unknown")
        self.assertEqual(provenance(record(), {})["status"], "unknown")

    def test_root_and_auto_branch(self):
        self.assertEqual(provenance(record(), self.goals)["status"], "eticahub")
        r = record()
        r["goalId"] = "branch"
        self.goals["branch"] = {"parentGoalId": "root"}
        self.assertEqual(provenance(r, self.goals)["status"], "eticahub")

    def test_community_ancestry_overrides_automated_branch(self):
        r = record()
        r["goalId"] = "branch"
        self.goals["branch"] = {
            "parentGoalId": "root",
            "submitterTag": "autopilot-seed",
        }
        self.goals["root"]["submitterWallet"] = "0xuser"
        self.assertEqual(provenance(r, self.goals)["status"], "community")

    def test_record_and_intermediate_wallet_override_root(self):
        r = record()
        r["submitterWallet"] = "0xuser"
        self.assertEqual(provenance(r, self.goals)["status"], "community")
        del r["submitterWallet"]
        r["goalId"] = "branch"
        self.goals["branch"] = {"parentGoalId": "root", "submitterWallet": "0xuser"}
        self.assertEqual(provenance(r, self.goals)["status"], "community")

    def test_cycles_and_missing_ancestors_fail_closed(self):
        self.assertEqual(
            provenance(record(), {"root": {"parentGoalId": "root"}})["status"],
            "unknown",
        )
        self.assertEqual(
            provenance(record(), {"root": {"parentGoalId": "gone"}})["status"],
            "unknown",
        )

    def test_rejected_is_preserved_and_metadata_is_escaped(self):
        m = metadata(record())
        self.assertEqual(m["license"], "cc-by-4.0")
        self.assertIn("rejected", m["description"])
        self.assertNotIn("<script>", m["description"])
        self.assertIn("&lt;script&gt;", m["description"])
        self.assertIn("0 cysteines", m["description"])
        self.assertEqual(m["upload_type"], "dataset")

    def test_cysteines_do_not_claim_a_bond(self):
        r = record()
        r["bestCandidate"]["sequence"] = "CAC"
        self.assertFalse(any("cannot form" in x for x in limitations(r)))
        self.assertTrue(any("not establish binding" in x for x in limitations(r)))

    def test_disulfide_free_request_is_not_unmet_stapling(self):
        r = record()
        r["prompt"] = "Design a disulfide-free peptide"
        self.assertFalse(any("disulfide-stapling" in x for x in limitations(r)))
        r["prompt"] = "Avoid disulfide bonds in this design"
        self.assertFalse(any("disulfide-stapling" in x for x in limitations(r)))

    def test_unreviewed_source_fields_are_refused(self):
        r = record()
        r["bestPdb"] = "private"
        with self.assertRaisesRegex(ValueError, "Unreviewed source fields: bestPdb"):
            validate(r)

    def test_validation(self):
        for key, value in [
            ("id", "../path"),
            ("completedAt", float("nan")),
            ("candidates", []),
        ]:
            r = record()
            r[key] = value
            with self.assertRaises(ValueError):
                validate(r)
        r = record()
        r["candidates"].append(r["candidates"][0])
        with self.assertRaises(ValueError):
            validate(r)
        r = record()
        r["bestCandidate"] = {"index": 99, "sequence": "AAA"}
        with self.assertRaises(ValueError):
            validate(r)

    def test_package_includes_every_candidate_and_exact_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            source = tmp / "source.json"
            source.write_text(json.dumps(record(), indent=2))
            out = tmp / "package"
            build(source, self.goals, out)
            self.assertEqual((out / "record.json").read_bytes(), source.read_bytes())
            self.assertIn("APPDEA", (out / "candidates.fasta").read_text())
            self.assertTrue((out / "report.pdf").read_bytes().startswith(b"%PDF"))
            proof = json.loads((out / "provenance.json").read_text())
            self.assertEqual(proof["structureAvailability"], "coordinates not supplied")
            self.assertEqual(proof["recordSha256"], sha(source.read_bytes()))
            for line in (out / "SHA256SUMS").read_text().splitlines():
                digest, name = line.split("  ")
                self.assertEqual(digest, sha((out / name).read_bytes()))
            with self.assertRaises(ValueError):
                build(source, self.goals, out)

    def test_pdb_matches_selected_sequence(self):
        pdb = b"ATOM      1  CA  ALA A   1       1.000   2.000   3.000  1.00 50.00           C\n"
        validate_pdb(pdb, "A")
        with self.assertRaises(ValueError):
            validate_pdb(pdb, "C")
        with self.assertRaises(ValueError):
            validate_pdb(b"REMARK no coordinates", "A")
        with self.assertRaises(ValueError):
            validate_pdb(pdb + pdb, "AA")

    def test_unattributed_publication_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.json"
            source.write_text(json.dumps(record()))
            with self.assertRaisesRegex(ValueError, "unknown"):
                build(source, {}, Path(tmp) / "package")


if __name__ == "__main__":
    unittest.main()
