# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FajarRizikAinulyakin/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/FajarRizikAinulyakin/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

An entry for the make.fun competition `hidden-spec-cli-01-run-20261122`
(Build mend, one patch tool for every AI edit format, 22 November 2026).

`main.ts` is mend, the command-line tool `SPEC.md` specifies: it reads a patch
in one of four formats — unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — finds the lines each edit names, and writes every change or none.
`runner.ts` is the kit's runner, kept as it is: in a trial it reads the
checks from the trial env and runs `main.ts` on each one.

## How it works

The working directory is the root of a tree of text files, and every path in
a patch is relative to it:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-` (or nothing) to read it from standard
  input. `--format` names one format (`unified`, `search-replace`, `v4a`,
  `json`); `auto`, the default, detects it. `--check` does everything but
  write. `--strict` matches lines exactly (tier 0 only).
- Each edit names the lines it replaces, and mend finds them at the first of
  three matching tiers where they occur: exact lines, lines equal once
  trailing spaces and tabs are removed, or lines equal once leading and
  trailing spaces and tabs are removed. At tier 2 the new lines are
  re-indented from the patch's indentation to the file's; context lines are
  always written as the file's own matched lines.
- A unified hunk takes the occurrence nearest its (possibly wrong) line
  number; a SEARCH/REPLACE block fails when its old lines occur more than
  once; a V4A chunk takes the first occurrence at or after its cursor, after
  its anchor. A file keeps its own line breaks (LF or CRLF) and its final
  line break, except where a unified hunk's `\ No newline at end of file`
  says otherwise.
- Every path is checked for safety before anything else about it. A failed
  edit changes nothing, and the edits after it still run, so every failure
  is reported; when any edit failed, no file is written. On success mend
  prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for a
  move) and `ok: <n> files`.

Pure: no clock, no randomness, no locale, nothing kept from one run to the
next. Node 22 and its standard library alone — no dependencies, no network,
no WASM or native addons.

## Run it

```sh
# apply a patch file to the current tree
node main.ts fix.patch

# check what a patch would do, without writing
node main.ts --check fix.patch

# read the patch from standard input
cat fix.patch | node main.ts -
```

## Grade locally

From the unpacked kit directory (Docker is the default driver; `--driver
process` runs the entry on this machine instead):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

Or run the practice set directly from this repository (with the kit's
`check.ts` beside `main.ts`):

```sh
node check.ts <kit>/program/generator/practice.json
```

## Results (practice set, this machine)

- All 100 practice checks pass (unified 30, search_replace 20, v4a 20,
  json 15, cli 15): practice score 1000. The same run twice gives the same
  result, and the trial replay reproduces byte for byte.
- 59 further hand-built edge cases pass, each derived from a sentence of
  `SPEC.md` the practice set does not show: empty-old insertions, deletions
  to the end of a file with and without `\ No newline at end of file`,
  creations with and without a final line break, sections with no hunks,
  rename-only diffs, malformed `diff --git` and hunk headers, nearest-tie
  hunks, accumulated line drift across hunks, `--strict` rejections,
  SEARCH/REPLACE blocks with no path line, V4A anchors, end-of-file chunks
  and pure moves, and the usage, `--check`, `--format` and no-patch
  command-line cases.

## License

MIT — see `LICENSE`.
