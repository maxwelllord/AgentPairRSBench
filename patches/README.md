# Changes to rs-sdk

`rs-sdk.patch` holds every change this benchmark makes to
[rs-sdk](https://github.com/MaxBittker/rs-sdk), against commit
`55fa26ccaad35417c4fe828000e5d832512186c1`. The changes are described under
"Local patches to rs-sdk" in [`bench/README.md`](../bench/README.md).

```sh
git clone https://github.com/MaxBittker/rs-sdk
cd rs-sdk
git checkout 55fa26ccaad35417c4fe828000e5d832512186c1
git apply ../patches/rs-sdk.patch
bun wiki/generate-npcs.ts   # regenerate the NPC wiki pages with the patched generator
```

Rebuild the client and repack the content after applying (see `bench/README.md`).
