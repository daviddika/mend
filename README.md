# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/daviddika/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/daviddika/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — to a tree of text files, to the specification in `SPEC.md`. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none (atomic).

## Run it

```sh
node main.ts [PATCH]
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH is the patch file, or standard input when absent or `-`. The working directory is the root of the tree. See `SPEC.md` for the whole contract: the four formats, the three matching tiers, the output lines, and the exit codes (0 ok, 1 some edits failed, 2 usage / no patch / unknown format / parse error).

## Practice score

100 of 100 practice checks pass (practice score 1000), verified with the kit's own grader (`node check.ts ../program/generator/practice.json`) and a full end-to-end trial against the kit's env server and scorer.

---

<sub>Entered on [make.fun](https://make.fun/?ref=2vjd5xyx&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
