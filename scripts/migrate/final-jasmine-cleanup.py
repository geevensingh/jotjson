#!/usr/bin/env python3
"""
Final Jasmine -> Vitest cleanup pass.

Preserves CRLF line endings strictly (binary read/write).

Replacements:
  1. `<spy>.calls\r\n<ws>.allArgs()` -> `<spy>.mock.calls`
  2. `<spy>.calls\r\n<ws>.all()`     -> `<spy>.mock.calls` (also see #2b for `.args` access)
  2b. `<spy>.mock.calls\r\n<ws>.filter((call) => call.args[N]` -> `.filter((call) => call[N]`
      (handled by string-level fix-up below)
  3. `expect(<x>).toHaveBeenCalledOnceWith(...)` -> `expect(<x>).toHaveBeenCalledExactlyOnceWith(...)`
"""
import re
import sys
from pathlib import Path

ROOT = Path(r"C:\Repos\jotjson-3a43b2a9-a508-40a3-a617-51a09c7a2c84\src")

# Pattern 1: foo.calls\r\n<ws>.allArgs() -> foo.mock.calls
# The whole multi-line chain ".calls\n     .allArgs()" becomes ".mock.calls"
# (subsequent chained calls on the next line stay aligned to original indent)
RX_CALLS_ALLARGS = re.compile(rb"\.calls\r?\n(\s+)\.allArgs\(\)")

# Pattern 2: foo.calls\r\n<ws>.all() -> foo.mock.calls   (Jasmine .all() != .allArgs(); but in our codebase
# all usages of .all() are followed by .filter((call) => call.args[N]), and the .args access is rewritten by
# a follow-on pass.)
RX_CALLS_ALL = re.compile(rb"\.calls\r?\n(\s+)\.all\(\)")

# Pattern 3: toHaveBeenCalledOnceWith -> toHaveBeenCalledExactlyOnceWith
RX_ONCE_WITH = re.compile(rb"toHaveBeenCalledOnceWith\b")

# Pattern 4 (post pattern 2): in a chain we just produced, rewrite `call.args[N]` to `call[N]`.
# Only within the .filter((call) => call.args[...]) idiom from the rewritten .all() chain.
RX_CALL_ARGS_AFTER_ALL = re.compile(rb"\.filter\((\(?call\)?) => call\.args\[")


def process_file(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    n_aa = 0
    n_all = 0
    n_once = 0

    new_data, n_aa = RX_CALLS_ALLARGS.subn(rb".mock.calls", data)

    new_data2, n_all = RX_CALLS_ALL.subn(rb".mock.calls", new_data)
    if n_all > 0:
        # Also rewrite the subsequent ".filter((call) => call.args[N]" to drop ".args".
        # We only do this in files where we just made a .all() -> .mock.calls rewrite,
        # to avoid touching test files where .args is legitimately part of a different idiom.
        new_data2 = RX_CALL_ARGS_AFTER_ALL.sub(rb".filter(\1 => call[", new_data2)

    new_data3, n_once = RX_ONCE_WITH.subn(rb"toHaveBeenCalledExactlyOnceWith", new_data2)

    if new_data3 != data:
        path.write_bytes(new_data3)

    return n_aa, n_all, n_once


def main() -> int:
    test_files = sorted(
        p for p in ROOT.rglob("*.test.ts")
        if p.is_file() and "__screenshots__" not in p.parts
    )
    grand_aa = grand_all = grand_once = 0
    touched: list[tuple[Path, int, int, int]] = []
    for path in test_files:
        n_aa, n_all, n_once = process_file(path)
        if n_aa or n_all or n_once:
            touched.append((path, n_aa, n_all, n_once))
            grand_aa += n_aa
            grand_all += n_all
            grand_once += n_once

    for path, n_aa, n_all, n_once in touched:
        rel = path.relative_to(ROOT)
        print(f"  {rel}: allArgs={n_aa} all={n_all} onceWith={n_once}")

    print(f"\nTotals: {grand_aa} allArgs / {grand_all} all() / {grand_once} toHaveBeenCalledOnceWith")
    print(f"Files modified: {len(touched)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
