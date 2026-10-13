"""Summarize private saved Runs without publishing transcript or model prose.

Mistral billing is an estimate from token counts and explicitly supplied rates;
Jev cost is the response-reported charge. Failed Runs retain known checkpoint
usage, which can omit rejected responses and cancelled upstream requests.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def metrics(path, input_rate, output_rate):
    raw = path.read_bytes()
    run = json.loads(raw)
    sources = run["job"]["input"]["transcripts"]
    source_map = {t["id"]: t["text"].splitlines() for t in sources}
    debrief = run["artifacts"][0]["debrief"] if run["artifacts"] else None
    if debrief:
        generation = debrief["generation_usage"]
        judgment = debrief["judgment_usage"]
    else:
        generation = {"input_tokens": 0, "output_tokens": 0}
        judgment = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0}
        for trace in run["traces"]:
            details = trace["details"]
            usage = details.get("evaluation", {}).get("usage") or details.get("usage")
            if usage:
                target = generation if trace["phase"] == "Candidates extracted" else judgment
                for key in ["input_tokens", "output_tokens"]:
                    target[key] += usage[key]
                if target is judgment:
                    cost = usage.get("cost_usd")
                    if cost is None:
                        target["cost_usd"] = None
                    elif target["cost_usd"] is not None:
                        target["cost_usd"] += cost
    estimate = (generation["input_tokens"] * input_rate + generation["output_tokens"] * output_rate) / 1e6
    invalid_supported_citations = 0
    if debrief:
        for item in debrief["items"]:
            if item["status"] != "supported":
                continue
            for citation in item["evidence"]:
                lines = source_map.get(citation["transcript_id"], [])
                start, end = citation["start_line"], citation["end_line"]
                if not (0 < start <= end <= len(lines) and citation["quote"] in "\n".join(lines[start - 1:end])):
                    invalid_supported_citations += 1
    return {
        "experiment": path.parent.name + "/" + path.name,
        "raw_output_sha256": digest(raw),
        "source_sha256": [digest(t["text"].encode()) for t in sources],
        "source_bytes": [len(t["text"].encode()) for t in sources],
        "status": run["job"]["status"],
        "concurrency": run.get("concurrency", debrief.get("segment_concurrency") if debrief else None),
        "elapsed_ms": run["elapsed_ms"],
        "artifact_count": len(run["artifacts"]),
        "segments": len(debrief["segments"]) if debrief else None,
        "dialogue_lines": debrief["dialogue_lines"] if debrief else None,
        "items_by_status": dict(collections.Counter(i["status"] for i in debrief["items"])) if debrief else {},
        "proposals": len(run["artifacts"][0]["actions"]) if debrief else 0,
        "reconciliation_calls": len(debrief["reconciliation"]) if debrief else None,
        "generation_usage": generation,
        "judgment_usage": judgment,
        "mistral_estimated_usd": estimate,
        "estimated_combined_usd": estimate + judgment["cost_usd"] if judgment.get("cost_usd") is not None else None,
        "jev_cost_known": judgment.get("cost_usd") is not None,
        "cost_boundary": "estimated Mistral plus response-reported Jev; incomplete known checkpoint usage for failed runs",
        "supported_citation_mismatches": invalid_supported_citations,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("outputs", nargs="+", type=Path)
    parser.add_argument("--mistral-input-per-million", required=True, type=float)
    parser.add_argument("--mistral-output-per-million", required=True, type=float)
    args = parser.parse_args()
    print(json.dumps([metrics(p, args.mistral_input_per_million, args.mistral_output_per_million) for p in args.outputs], indent=2))
