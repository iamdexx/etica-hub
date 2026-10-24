"""Build an evidence-labelled Zenodo dataset; never infer ownership from no wallet."""

import argparse
import hashlib
import html
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

NOTICE = (
    "Computational predictions only. No experimental or clinical evidence is supplied. "
    "Scores, automated checks and resolved identifiers do not establish binding, "
    "novelty, efficacy, safety or medical benefit."
)
LICENSE = "CC-BY-4.0"
CREATORS = [{"name": "Mabry, Deaven", "affiliation": "EticaHub Labs"}]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_url(record_id):
    if not re.fullmatch(r"[\w.:-]{1,128}", record_id):
        raise ValueError("Invalid archive identifier")
    return "https://eticahub.com/labs/archive/" + record_id


def provenance(record, goals):
    """Walk stored goal ancestry, including branches of community submissions."""
    lineage: list[dict] = []
    if record.get("submitterWallet"):
        return {
            "status": "community",
            "wallet": record["submitterWallet"],
            "lineage": lineage,
        }
    gid = record.get("goalId")
    seen = set()
    while gid and gid not in seen:
        seen.add(gid)
        goal = goals.get(gid)
        if not goal:
            break
        lineage.append({"goalId": gid, "parentGoalId": goal.get("parentGoalId")})
        if goal.get("submitterWallet"):
            return {
                "status": "community",
                "wallet": goal["submitterWallet"],
                "lineage": lineage,
            }
        if goal.get("parentGoalId"):
            gid = goal["parentGoalId"]
            continue
        if goal.get("submitterTag") == "autopilot-seed":
            return {
                "status": "eticahub",
                "lineage": lineage,
                "basis": "Root goal has server-assigned autopilot-seed tag; no originating wallet in stored lineage.",
            }
        break
    return {"status": "unknown", "lineage": lineage}


def validate(record):
    source_url(record["id"])
    if not isinstance(record.get("completedAt"), (int, float)) or not math.isfinite(
        record["completedAt"]
    ):
        raise ValueError("Missing valid completion timestamp")
    candidates = record.get("candidates")
    if not candidates or not isinstance(candidates, list):
        raise ValueError("No archived candidates")
    ids = set()
    for candidate in candidates:
        index, seq = candidate.get("index"), candidate.get("sequence")
        if type(index) is not int or index < 0 or index in ids:
            raise ValueError("Invalid or duplicate candidate index")
        if not isinstance(seq, str) or not re.fullmatch("[A-Z]+", seq):
            raise ValueError("Sequence is missing or not an uppercase residue string")
        ids.add(index)
    best = record.get("bestCandidate", {})
    if not any(
        c["index"] == best.get("index") and c["sequence"] == best.get("sequence")
        for c in candidates
    ):
        raise ValueError("Selected candidate does not match candidate list")


def limitations(record):
    best = record["bestCandidate"]
    limits = [
        NOTICE,
        'The stored "verified" grade is an internal automated check, not peer review or independent scientific validation.',
        "Hypothesis, approach and success criteria below are proposed research, not experiments performed.",
        "Checkpoint versions, random seeds and complete tool inputs are not established by this archive export; exact rerun reproducibility is not claimed.",
    ]
    objective = " ".join(
        str(record.get(k, ""))
        for k in ["prompt", "hypothesis", "approach", "successCriteria"]
    )
    if re.search(r"disulfide", objective, re.I) and best["sequence"].count("C") < 2:
        limits.append(
            f"Selected candidate #{best['index']} has {best['sequence'].count('C')} cysteines. "
            "Its recorded sequence cannot form an intramolecular cysteine disulfide bridge; "
            "the proposed disulfide-stapling objective is not demonstrated. "
            "The sequence alone also does not establish a non-canonical crosslink."
        )
    checks = best.get("verification", {}).get("checks", [])
    for check in checks:
        if check.get("status") in ["fail", "warn"]:
            limits.append(
                f"Automated {check['status']}: {check.get('label', check.get('id'))}: {check.get('detail', '')}"
            )
    reasons = record.get("evidence", {}).get("publication", {}).get("reasons", [])
    limits.extend("Internal publication gate: " + reason for reason in reasons)
    return limits


def title(record):
    return f"EticaHub Labs computational protein-design dataset — {record.get('disease') or 'Unclassified condition'} — run {record['id'].removesuffix('-archive')}"


def metadata(record):
    best = record["bestCandidate"]
    grade = best.get("verification", {}).get("grade", "not assessed")
    description = (
        "<p><strong>Computational dataset / research audit record, not a validated treatment.</strong></p>"
        f"<p>This individual run contains {len(record['candidates'])} archived candidates from "
        f"{record.get('iterations', 'unrecorded')} reported iterations. "
        f"The pipeline-selected candidate is #{best['index']}; its internal automated grade is {html.escape(grade)}.</p>"
        "<p><strong>Proposed research question (not a demonstrated outcome):</strong> "
        + html.escape(record.get("prompt", "Not recorded"))
        + "</p>"
        "<p><strong>Evidence and limitations</strong></p><ul>"
        + "".join("<li>" + html.escape(x) + "</li>" for x in limitations(record))
        + "</ul>"
        "<p><strong>Files:</strong> evidence report, original JSON, all candidate sequences, "
        "provenance manifest, license and SHA-256 checksums. Available predicted coordinate exports "
        "are included and explicitly labelled; missing structures are not reconstructed.</p>"
        "<p>AI-assisted research generated by the EticaHub Labs autopilot. "
        "Deaven Mabry is credited as responsible project creator, with EticaHub Labs affiliation. "
        "Cited literature remains the work of its original authors; identifier resolution is not claim support.</p>"
    )
    return {
        "upload_type": "dataset",
        "title": title(record),
        "creators": CREATORS,
        "description": description,
        "access_right": "open",
        "license": "cc-by-4.0",
        "keywords": [
            "computational protein design",
            "AI-assisted research",
            "EticaHub Labs",
            record.get("disease") or "unclassified",
            "unvalidated predictions",
        ],
        "related_identifiers": [
            {"identifier": source_url(record["id"]), "relation": "isDerivedFrom"}
        ],
        "notes": "Archive record ID: "
        + record["id"]
        + ". Scientific limitations are retained, including failed and inconclusive checks.",
    }


def make_pdf(record, proof, output, source_hash):
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate,
        Paragraph,
        Spacer,
        Table,
        TableStyle,
        PageBreak,
        KeepTogether,
    )

    ink = colors.HexColor("#152c3a")
    accent = colors.HexColor("#116b75")
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            "Body",
            fontName="Helvetica",
            fontSize=9.5,
            leading=14,
            textColor=ink,
            spaceAfter=8,
            splitLongWords=True,
        )
    )
    styles.add(
        ParagraphStyle("SmallBody", parent=styles["Body"], fontSize=8, leading=11)
    )
    styles.add(
        ParagraphStyle(
            "Section",
            fontName="Helvetica-Bold",
            fontSize=16,
            leading=20,
            textColor=accent,
            spaceBefore=16,
            spaceAfter=10,
            keepWithNext=True,
        )
    )
    styles.add(
        ParagraphStyle(
            "Cover",
            fontName="Helvetica-Bold",
            fontSize=27,
            leading=32,
            textColor=ink,
            spaceAfter=18,
        )
    )
    styles.add(
        ParagraphStyle(
            "Label",
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=13,
            textColor=accent,
            spaceBefore=12,
            spaceAfter=5,
        )
    )
    styles.add(
        ParagraphStyle(
            "Seq",
            fontName="Courier",
            fontSize=8,
            leading=12,
            textColor=ink,
            spaceAfter=10,
            wordWrap="CJK",
        )
    )
    story = []

    def p(text, style="Body"):
        return Paragraph(html.escape(str(text)).replace("\n", "<br/>"), styles[style])

    def section(name):
        story.append(p(name, "Section"))

    def table(rows, widths):
        cells = [[p(c, "SmallBody") for c in row] for row in rows]
        t = Table(cells, colWidths=widths, repeatRows=1, hAlign="LEFT")
        t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e5eff0")),
                    (
                        "ROWBACKGROUNDS",
                        (0, 1),
                        (-1, -1),
                        [colors.white, colors.HexColor("#f5f7f8")],
                    ),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 7),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                ]
            )
        )
        story.append(t)

    def page(canvas, doc):
        canvas.setStrokeColor(colors.HexColor("#cddbdd"))
        canvas.line(20 * mm, 282 * mm, 190 * mm, 282 * mm)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(accent)
        canvas.drawString(20 * mm, 286 * mm, "ETICAHUB LABS  /  RESEARCH DATA")
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(ink)
        canvas.drawString(
            20 * mm,
            13 * mm,
            "Computational evidence only  |  CC-BY-4.0  |  " + record["id"][:8],
        )
        canvas.drawRightString(190 * mm, 13 * mm, str(doc.page))

    best = record["bestCandidate"]
    completed = datetime.fromtimestamp(
        record["completedAt"] / 1000, timezone.utc
    ).isoformat()
    story.extend(
        [
            Spacer(1, 12 * mm),
            p("COMPUTATIONAL DATASET / INDIVIDUAL RUN", "Label"),
            p("Protein-design research record", "Cover"),
            p(record.get("disease") or "Condition not recorded", "Section"),
            p(
                record.get("goalTitle")
                or record.get("prompt")
                or "Research objective not recorded"
            ),
            p("Deaven Mabry · EticaHub Labs", "Label"),
            p(
                "AI-assisted autopilot output. This report distinguishes recorded computations from proposed experiments."
            ),
            p("Run completed (UTC): " + completed),
            p("Record: " + record["id"], "SmallBody"),
        ]
    )
    section("Evidence at a glance")
    grade = best.get("verification", {}).get("grade", "not assessed")
    table(
        [
            ["Candidates", "Pipeline-selected candidate", "Automated grade"],
            [
                len(record["candidates"]),
                f"#{best['index']} · {len(best['sequence'])} residues",
                grade,
            ],
        ],
        [55 * mm, 65 * mm, 50 * mm],
    )
    story.append(Spacer(1, 6 * mm))
    story.append(p(NOTICE))
    section("Main limitation")
    cysteine = [x for x in limitations(record) if "cysteines" in x]
    story.append(
        p(
            cysteine[0]
            if cysteine
            else "No supplied experimental data demonstrate that the proposed research objective was met."
        )
    )
    story.append(PageBreak())
    section("01 / Proposed question and methods")
    story.append(
        p(
            "The following text is the original AI-generated research plan. It is not an account of experiments performed."
        )
    )
    for key, label in [
        ("prompt", "Research question"),
        ("hypothesis", "Hypothesis"),
        ("approach", "Proposed approach"),
        ("successCriteria", "Proposed success criteria"),
    ]:
        story.extend([p(label, "Label"), p(record.get(key) or "Not recorded")])
    section("02 / Recorded computational outputs")
    engines = sorted({c["engine"] for c in record["candidates"] if c.get("engine")})
    story.append(
        p(
            f"Reported iterations: {record.get('iterations', 'not recorded')}. Engine labels present: {', '.join(engines) or 'none'}. "
            "These are archive labels, not independently audited software versions. Stored score units and calibration are not established here; "
            "do not interpret a score as binding probability or substitute it for pLDDT."
        )
    )
    rows = [
        ["Candidate", "Residues / Cys", "Stored score", "Automated grade", "Engine"]
    ]
    for c in record["candidates"]:
        score = c.get("score")
        shown = (
            f"{score:.4f}"
            if isinstance(score, (float, int)) and math.isfinite(score)
            else "Not recorded"
        )
        rows.append(
            [
                f"#{c['index']}"
                + (" (selected)" if c["index"] == best["index"] else ""),
                f"{len(c['sequence'])} / {c['sequence'].count('C')}",
                shown,
                c.get("verification", {}).get("grade", "not assessed"),
                c.get("engine", "not recorded"),
            ]
        )
    table(rows, [32 * mm, 29 * mm, 29 * mm, 42 * mm, 38 * mm])
    story.append(PageBreak())
    section("03 / Selected candidate: automated checks")
    checks = best.get("verification", {}).get("checks", [])
    if checks:
        table(
            [["Check", "Status", "Recorded detail"]]
            + [
                [c.get("label", c.get("id")), c.get("status"), c.get("detail", "")]
                for c in checks
            ],
            [42 * mm, 22 * mm, 106 * mm],
        )
    else:
        story.append(p("No candidate checks were archived."))
    section("04 / Limitations and unmet objectives")
    for limit in limitations(record):
        story.append(p("• " + limit))
    story.append(PageBreak())
    section("05 / Candidate sequences and design rationale")
    story.append(
        p(
            "All archived candidates are retained, including weak and rejected designs. Rationale is model-generated text, not validated mechanism."
        )
    )
    for c in record["candidates"]:
        story.append(
            KeepTogether(
                [
                    p(
                        f"Candidate #{c['index']} / {len(c['sequence'])} residues",
                        "Label",
                    ),
                    p(c["sequence"], "Seq"),
                ]
            )
        )
        story.append(p(c.get("rationale") or "No rationale recorded.", "SmallBody"))
    story.append(PageBreak())
    section("06 / Target identifiers and literature context")
    story.append(
        p(
            "Identifier resolution establishes the existence of a database entry, not whether it supports the proposed mechanism, treatment or outcome. "
            "The target list and citations below are recorded metadata, not a relevance assessment."
        )
    )
    g = record.get("grounding") or {}
    for t in g.get("targets", []):
        story.append(
            p(
                f"{t.get('symbol')} / UniProt {t.get('accession')} / {t.get('proteinName')}",
                "SmallBody",
            )
        )
    if not g.get("targets"):
        story.append(p("No resolved target identifiers recorded."))
    for citation in g.get("citations", []):
        story.append(
            p(f"PubMed {citation.get('id')}: {citation.get('title')}", "SmallBody")
        )
        if citation.get("authors"):
            story.append(
                p(
                    str(citation["authors"]) + " — " + str(citation.get("journal", "")),
                    "SmallBody",
                )
            )
    if not g.get("citations"):
        story.append(
            p(
                "No resolved citations recorded. Original references, if any, remain in record.json."
            )
        )
    if record.get("literatureContext"):
        story.append(
            p(
                "Additional retrospective literature context is retained in record.json. It is not represented as evidence used during the original run."
            )
        )
    section("07 / Provenance, files and reuse")
    story.append(p(proof["basis"]))
    story.append(p("Root goal: " + proof["lineage"][-1]["goalId"], "SmallBody"))
    story.append(p("Source: " + source_url(record["id"]), "SmallBody"))
    story.append(p("Original record SHA-256: " + source_hash, "SmallBody"))
    story.append(
        p(
            "The provenance manifest lists retrieval time, lineage and structure availability. SHA256SUMS covers every payload file. "
            "Any PDB file is a predicted coordinate export, not an experimental structure; a sequence-keyed export may not preserve the exact original fold version."
        )
    )
    story.append(
        p(
            "Dataset license: Creative Commons Attribution 4.0 International (CC-BY-4.0). Credit Deaven Mabry / EticaHub Labs, "
            "cite this record’s DOI, link the license and indicate changes. No endorsement is implied. "
            "This license does not relicense cited literature or the EticaHub application software."
        )
    )
    doc = SimpleDocTemplate(
        str(output),
        pagesize=(210 * mm, 297 * mm),
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=23 * mm,
        bottomMargin=24 * mm,
        title=title(record),
        author="Deaven Mabry / EticaHub Labs",
        pageCompression=1,
    )
    doc.build(story, onFirstPage=page, onLaterPages=page)


def validate_pdb(data, sequence):
    amino_acids = dict(
        zip(
            "ALA ARG ASN ASP CYS GLU GLN GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL".split(),
            "ARNDCEQGHILKMFPSTWYV",
        )
    )
    residues = []
    positions = set()
    for line in data.decode("utf-8").splitlines():
        if line.startswith("ATOM") and line[12:16].strip() == "CA":
            position = line[21:27]
            if position in positions:
                raise ValueError("Ambiguous multi-model or alternate-location PDB")
            positions.add(position)
            residues.append(amino_acids.get(line[17:20].strip(), "?"))
    if not residues or "".join(residues) != sequence:
        raise ValueError("PDB residue sequence does not match selected candidate")


def build(source, goals, directory, pdb=None):
    raw = Path(source).read_bytes()
    record = json.loads(raw)
    validate(record)
    proof = provenance(record, goals)
    if proof["status"] != "eticahub":
        raise ValueError(
            "Owner publication forbidden: provenance is " + proof["status"]
        )
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError("Package output must be empty; preserve existing snapshots")
    (directory / "record.json").write_bytes(raw)
    (directory / "candidates.fasta").write_text(
        "".join(
            f">{record['id']}|candidate={c['index']}|computational-prediction\n{c['sequence']}\n"
            for c in record["candidates"]
        )
    )
    if pdb:
        data = Path(pdb).read_bytes()
        validate_pdb(data, record["bestCandidate"]["sequence"])
        (directory / "best-candidate.pdb").write_bytes(data)
    proof.update(
        {
            "recordId": record["id"],
            "recordSha256": sha(raw),
            "license": LICENSE,
            "creators": CREATORS,
            "source": source_url(record["id"]),
            "packagedAt": datetime.now(timezone.utc).isoformat(),
            "structureAvailability": "best-candidate export supplied"
            if pdb
            else "coordinates not supplied",
            "structureCaveat": "Sequence-keyed predicted coordinate export; original fold version is not established.",
        }
    )
    (directory / "provenance.json").write_text(json.dumps(proof, indent=2) + "\n")
    (directory / "zenodo-metadata.json").write_text(
        json.dumps(metadata(record), indent=2) + "\n"
    )
    (directory / "LICENSE.txt").write_text(
        "Dataset: Creative Commons Attribution 4.0 International (CC-BY-4.0)\n"
        "https://creativecommons.org/licenses/by/4.0/legalcode\n"
        "Creator: Deaven Mabry. Affiliation: EticaHub Labs.\n"
        "Give appropriate credit, cite the DOI, link the license and indicate changes.\n"
        "No endorsement implied. Cited third-party literature and application software are not relicensed.\n"
    )
    (directory / "README.md").write_text(
        "# " + title(record) + "\n\n" + NOTICE + "\n\n"
        "## Contents\n- report.pdf: evidence-led research report\n- record.json: original archive export\n"
        "- candidates.fasta: every archived candidate\n- provenance.json: source, authorship and structure availability\n"
        "- zenodo-metadata.json: intended dataset metadata\n- LICENSE.txt: CC-BY-4.0\n"
        "- SHA256SUMS: payload integrity checks\n"
        + (
            "- best-candidate.pdb: supplied predicted coordinate export\n"
            if pdb
            else "- Coordinates not supplied; none were fabricated.\n"
        )
        + "\n## Limitations\n"
        + "\n".join("- " + x for x in limitations(record))
        + '\n\nA source "published" label means an internal gate passed, not independent validation. '
        "Zenodo registration does not establish scientific validity.\n"
    )
    make_pdf(record, proof, directory / "report.pdf", sha(raw))
    (directory / "SHA256SUMS").write_text(
        "".join(
            f"{sha(p.read_bytes())}  {p.name}\n" for p in sorted(directory.iterdir())
        )
    )
    return proof


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True)
    parser.add_argument(
        "--goals",
        required=True,
        help="Private server-side goal snapshot; not public API summaries",
    )
    parser.add_argument("--output", required=True)
    parser.add_argument("--pdb")
    args = parser.parse_args()
    proof = build(
        args.record, json.loads(Path(args.goals).read_text()), args.output, args.pdb
    )
    print(
        json.dumps(
            {
                "recordId": proof["recordId"],
                "status": proof["status"],
                "output": args.output,
            }
        )
    )
