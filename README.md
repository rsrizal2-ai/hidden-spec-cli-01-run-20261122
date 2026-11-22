# mend

[![Node](https://img.shields.io/badge/node-22-green.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![make.fun](https://img.shields.io/badge/make.fun-hidden--spec--cli-01-blue)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend`, a command-line tool for [hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122) on make.fun.

`main.ts` applies AI-written edits in four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a tree of text files: it finds the lines an edit names at the first of three matching tiers (exact, trailing whitespace, leading and trailing whitespace), re-indents at tier 2, and changes every file or none. Run it as `node main.ts [options] [PATCH]`. MIT — see [LICENSE](LICENSE).
