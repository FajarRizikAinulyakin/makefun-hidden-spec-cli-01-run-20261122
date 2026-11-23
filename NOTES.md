# Notes

## What was built

`main.ts` starts from the kit's starter (SPEC.md sections 1–4, 9 and 10:
command line, output and exit codes, safe paths, format detection, JSON
edits, all-or-nothing write), kept as handed out. The work of this session
is sections 5–8 plus the move output:

- Section 5 — three-tier line matching (exact; trailing whitespace;
  leading and trailing whitespace), with tier-2 re-indentation of the new
  lines from the patch's leading whitespace to the file's, and context
  lines always written as the file's own matched lines.
- Section 6 — unified diffs: section headers (`diff --git`, `---`/`+++`,
  `rename from`/`to`, `new file mode`, `deleted file mode`), hunks with
  nearest-occurrence selection against the (possibly wrong) line number
  plus accumulated drift, empty-old insertions, and the `\ No newline at
  end of file` final-break rules for changes and creations.
- Section 7 — SEARCH/REPLACE blocks: path-line search skipping fences,
  falling back to the previous block's path, exact-once matching
  (`ambiguous` otherwise), creation on empty old lines.
- Section 8 — V4A patches: Begin/End Patch checks, Add/Delete/Update
  sections with trailing blank lines stripped, `*** Move to:`, anchored
  chunks with a cursor, end-of-file chunks, and the Update-section
  no-chunk parse error.
- Output — move edits print `R <old> -> <new>` sorted by the new path
  instead of a `D`/`A` pair, decided from the tree before and after the
  patch; a failed edit rolls the move list back with the tree.

## Decisions the practice set confirmed

- A hunk's nearest occurrence is by `A - 1 + d`, ties to the earlier one
  (`u-nearest`, `u-offset`).
- A `\` line only changes the final break when it directly follows the
  hunk's last context or `+` line (`u-noeol`); a pure deletion to the end
  of a file with a `\` after the `-` line still ends with a break.
- Tier-2 re-indentation replaces the patch's leading whitespace with the
  file's — including prepending it when the patch's first old line has
  none (`v-indent`: `} // node` becomes `  } // node`).
- V4A trailing blank lines at the end of a section are not part of it: a
  trailing ` ` context line before `*** End Patch` is dropped, not
  matched (`v-cursor`).
- Detection runs before parsing: a patch with a hunk but no unified
  marker is `error: format`, not `error: parse` — and the same holds for
  a V4A patch whose first line is not `*** Begin Patch`.
- The `--- ` line not followed by `+++ ` in a header is
  `error: parse <the line after it>`, i.e. the `---` line's number plus
  one (`u-parse`).

## Edge cases tested beyond the practice set

59 hand-built cases in `/tmp/mend-edge-tests.mjs`, each derived from a
sentence of SPEC.md the practice set does not show: empty-old insertions
(top, end, negative clamp), deletions to the end with and without `\`,
creations with and without a final break, hunk-less sections (change,
create, missing), rename-only diffs, malformed `diff --git` and hunk
headers, nearest-tie hunks, drift accumulation across hunks, `--strict`
rejections, move `exists`/`missing`, unsafe `..` paths, SEARCH/REPLACE
blocks with no path line (previous block's path, first-block parse
error), missing `=======`/`>>>>>>> REPLACE`, tier-2 re-indentation,
V4A missing `*** End Patch` (parse lines+1), Add/Delete section faults,
Update with no chunk and no `*** Move to:`, pure moves, anchors that
do not match, end-of-file chunks not at the end, `*** End of File` with
no chunk open, a body line after `*** End of File`, and the usage,
`--`, `--check`, `--format` and no-patch command-line cases. All 59
pass, as do all 100 practice checks (twice, and under the kit's
grade-local with a byte-identical replay).

## Things to watch in the hidden pool

- The pool tests sentences the practice set does not show. The guesses
  that remain, taken literally from SPEC.md: a second `---`/`+++` pair
  inside one header re-names the paths; a lone `+++ ` line in a header
  names the new path; `rename from`/`to` paths keep their text as
  written (no `a/`/`b/` strip); `*** End of File` with no chunk open is
  a parse error; a body line after `*** End of File` without a new `@@`
  is a parse error; a `diff --git` line must match
  `diff --git a/<X> b/<Y>` with single spaces and no trailing text.
- CRLF files: the file's lines are split at its own break and written
  back with it; JSON `str_replace` converts `\r\n` to `\n` for the
  match and back (starter code, kept as handed out).
