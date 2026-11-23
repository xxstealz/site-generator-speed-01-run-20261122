[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xxstealz/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xxstealz/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Flatline Site

A faster drop-in for makefun-site 1.0.0 — a static site generator that
answers every case byte-identically to the reference, in a fraction of the
CPU time.

## How it works

- `solve.js` — the whole build, written fresh: a fused single-pass Markdown
  renderer (no token array, no per-character regex escapes), a hand-rolled
  front-matter scanner, an ASCII fast path for slugs with memoised tag
  slugs, and templates compiled to plain JavaScript functions.
- `main.ts` — the driver: reads every case from `/input/cases.json`,
  answers each with `run`, writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for `/input` and
`/output` outside a container. Pure JavaScript, no dependencies, no
network, no WASM, no native code.
