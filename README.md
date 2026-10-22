# Agent Pair RS Bench

Teams of two LLM agents get 15 minutes in a 2004 RuneScape emulator
([rs-sdk](https://github.com/MaxBittker/rs-sdk)) to kill as many different kinds of enemy as they can.
Inspired by Max Bittker's [RuneBench](https://maxbittker.github.io/runebench/).

- `site/`: the results page
- `bench/`: the harness (run, score, timelapse); see [`bench/README.md`](bench/README.md)
- `patches/`: the changes made to rs-sdk
- `runs/`: per-run results, kill logs, positions and agent transcripts
