"""Recount the paired measurements without a browser or Node dependencies."""
import gzip
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path


run = Path(sys.argv[1])
samples = [json.loads(line) for line in (run / "samples.jsonl").read_text().splitlines()]
env = json.loads((run / "environment.json").read_text())
summary = json.loads((run / "summary.json").read_text())
with gzip.open(run / "reports.json.gz", "rt") as archive:
    reports = json.load(archive)

for key, body in reports.items():
    serialized = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    assert hashlib.sha256(serialized.encode()).hexdigest() == key
assert set(reports) == {row["sha"] for row in samples}
assert not summary["differences"]

index = {(r["page"], r["iteration"], r["phase"], r["arm"]): r for r in samples}
assert len(index) == len(samples) == summary["scans"] == len(env["pages"]) * env["count"] * 4
for page, fixture in env["pages"].items():
    for iteration in range(env["count"]):
        for phase in ("first", "repeat"):
            before, after = (index[(page, iteration, phase, arm)] for arm in ("baseline", "candidate"))
            assert before["sha"] == after["sha"], (page, iteration, phase)
            for r in (before, after):
                assert math.isfinite(r["ms"]) and r["ms"] > 0
                assert (r["navigationMs"] > 0) if phase == "first" else r["navigationMs"] is None
            body = reports[before["sha"]]
            assert all(c["type"] == "text" for c in body["content"])
            assert any("<fixture-origin>" + fixture["path"] in c["text"] and "Violations:" in c["text"]
                       for c in body["content"])

for arm, totals in summary["totals"].items():
    for metric, reported in totals.items():
        traversal = 0.
        for page in env["pages"]:
            selected = [index[(page, i, "first" if metric == "navigationAndFirst" else metric, arm)]
                        for i in range(env["count"])]
            times = [(r["ms"] + r["navigationMs"]) if metric == "navigationAndFirst" else r["ms"]
                     for r in selected]
            median = statistics.median(times)
            p95 = sorted(times)[math.ceil(len(times) * .95) - 1]
            assert summary["byPage"][page][arm][metric] == {"median": median, "p95": p95}
            traversal += median
        assert math.isclose(traversal, reported, rel_tol=1e-13)
print(f"{len(samples)} timed calls; {len(samples)//2} complete baseline/candidate response pairs "
      f"equal; {len(reports)} verified archived bodies; all median and p95 values verified.")
