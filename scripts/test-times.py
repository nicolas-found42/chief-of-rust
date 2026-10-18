#!/usr/bin/env python3
"""Print test timings with the context that makes them quotable.

A timing number is only useful with the machine, the commit and the state of
`target/debug/deps` beside it: a bloated `deps` directory inflates every
process-per-test run, so the same suite measures 20 s or 65 s depending on that
directory alone. This prints all of it, plus the per-binary split.

Usage:
    python3 scripts/test-times.py                 # whole workspace
    python3 scripts/test-times.py --test terminal # one binary, for iteration
"""
import os
import re
import subprocess
import sys
import time

# Process spawn cost grows with the entry count of the directory the test
# binary is spawned from: 0.02 s at 0 entries, 0.17 s at 100k, 0.47 s at 300k,
# ~0.93 s at 432k (measured on macOS, 18 cores). nextest spawns one process per
# test, so a large directory multiplies into tens of seconds.
DEPS_WARN_ENTRIES = 20_000

# `        PASS [   0.019s] (  1/236) chief-of-rust::terminal some_test`
RESULT = re.compile(
    r"^\s*(?P<outcome>[A-Z][A-Z ]*?)\s*\[\s*(?P<seconds>\d+(?:\.\d+)?)s\]"
    r"\s*\(\s*\d+/\d+\)\s+(?P<binary>\S+)\s+(?P<test>.+?)\s*$"
)


def run(command):
    return subprocess.run(command, capture_output=True, text=True)


def provenance():
    commit = run(["git", "rev-parse", "--short", "HEAD"]).stdout.strip() or "unknown"
    # Untracked tooling must not mark a measurement dirty; tracked edits must.
    dirty = bool(run(["git", "status", "--porcelain", "--untracked-files=no"]).stdout.strip())
    cores = os.cpu_count() or 0
    when = time.strftime("%Y-%m-%d %H:%M")
    return f"{commit}{' (dirty)' if dirty else ''}", cores, when


def deps_entries():
    try:
        return len(os.listdir("target/debug/deps"))
    except OSError:
        return None


def main():
    rest = sys.argv[1:]
    selected = []
    while rest:
        flag = rest.pop(0)
        if flag == "--test" and rest:
            selected += ["--test", rest.pop(0)]
        else:
            print(f"unknown argument: {flag}", file=sys.stderr)
            return 2

    if run(["cargo", "nextest", "--version"]).returncode != 0:
        print("cargo-nextest is required: cargo binstall cargo-nextest --secure", file=sys.stderr)
        return 1

    scope = selected[1] if selected else "workspace"
    command = ["cargo", "nextest", "run", "--workspace", "--locked", "--status-level", "all"]
    command += selected
    started = time.monotonic()
    result = run(command)
    wall = time.monotonic() - started

    by_binary = {}
    slowest = ("", "", 0.0)
    outcomes = {}
    output = result.stdout + "\n" + result.stderr
    for line in output.splitlines():
        match = RESULT.match(line)
        if not match:
            continue
        seconds = float(match["seconds"])
        binary = match["binary"].split(":")[-1]
        entry = by_binary.setdefault(binary, [0, 0.0])
        entry[0] += 1
        entry[1] += seconds
        if seconds > slowest[2]:
            slowest = (binary, match["test"], seconds)
        outcome = match["outcome"].split()[-1]
        outcomes[outcome] = outcomes.get(outcome, 0) + 1

    if not by_binary:
        print("no test results parsed; nextest output follows\n", file=sys.stderr)
        print(output[-6000:], file=sys.stderr)
        return 1

    commit, cores, when = provenance()
    entries = deps_entries()
    tests = sum(count for count, _ in by_binary.values())
    summed = sum(seconds for _, seconds in by_binary.values())

    print(f"test timings — {scope}")
    print(f"  commit   {commit}")
    print(f"  machine  {cores} cores, {when}")
    print(f"  target   target/debug/deps, {entries if entries is not None else 'absent'} entries")
    print(f"  command  {' '.join(command)}")
    print()
    print(f"  {'binary':<28}{'tests':>6}{'sec':>10}")
    for binary, (count, seconds) in sorted(by_binary.items(), key=lambda kv: -kv[1][1]):
        print(f"  {binary:<28}{count:>6}{seconds:>10.2f}")
    print(f"  {'all':<28}{tests:>6}{summed:>10.2f}")
    print()
    print("  seconds are summed per test; tests run in parallel, so wall is less")
    print(f"  wall {wall:.1f} s", end="")
    if slowest[0]:
        print(f"; slowest test {slowest[1]} {slowest[2]:.2f} s ({slowest[0]})", end="")
    print()
    failed = sum(count for outcome, count in outcomes.items() if outcome.endswith("FAIL"))
    if failed:
        print(f"  {failed} failed, {outcomes.get('PASS', 0)} passed")

    if entries is not None and entries >= DEPS_WARN_ENTRIES:
        print()
        print(f"  WARNING target/debug/deps holds {entries} entries. Process spawn cost grows with")
        print("          this count (0.02 s at 0, 0.17 s at 100k, 0.47 s at 300k) and nextest")
        print("          spawns one process per test, so these numbers are inflated. Prune")
        print("          before quoting them: cargo clean -p chief-of-rust")

    return 0


if __name__ == "__main__":
    sys.exit(main())
