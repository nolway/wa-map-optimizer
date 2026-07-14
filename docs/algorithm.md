# The optimization algorithm, step by step

This document explains how wa-map-optimizer turns the tilesets of a Tiled map into a small set of
optimized tileset textures, while guaranteeing that **every tile layer references tiles from a
single tileset** — the requirement for Phaser 4's `TilemapGPULayer`.

## The problem

A Tiled map references tiles by GID (global tile id). Each layer is a grid of GIDs, and each GID
points into one of the map's tilesets. Source maps typically embed huge tilesets of which only a
fraction is used, so the optimizer extracts the used tiles and re-packs them into new textures.

The naive approach — pack tiles into fixed-size textures in the order they are discovered — breaks
GPU rendering: a layer's tiles end up scattered across whatever textures happened to be open when
each tile was first seen. `TilemapGPULayer` needs all tiles of a layer in **one** tileset.

The constraints are:

- each layer must draw from exactly one tileset;
- a tileset may be shared by several layers;
- a tile may be duplicated into several tilesets if necessary, but as rarely as possible;
- textures must have power-of-2 dimensions (rectangles allowed, e.g. 2048×1024), capped at a
  configurable maximum size (default 4096×4096).

## Key insight: tilesets = clusters of layers

Since each layer needs exactly one tileset and tilesets can be shared, every valid solution has the
same shape: **partition the layers into clusters, and give each cluster one tileset containing the
union of the tiles used by its member layers.**

- Two layers in the same cluster share a tileset — zero duplication between them.
- Two layers in *different* clusters that share tiles force those tiles to be **duplicated** into
  both tilesets.

So the whole problem reduces to a single question: *which layers should be grouped together?*
Duplication is never decided tile by tile; it falls out of the clustering. (Finding the optimal
partition is NP-hard — it is a form of hypergraph partitioning — but a map has tens of layers, so a
good greedy heuristic is both fast and close to optimal.)

The optimizer runs in three passes.

## Pass 1 — Analysis (`src/LayerAnalysis.ts`)

Walk every tile layer of the map (recursing into group layers) and build, for each layer, the set
of tiles it uses:

1. **Strip flip bits.** Tiled stores horizontal/vertical/diagonal flips in bits 29–31 of the GID.
   The tile identity is `gid & 0x1FFFFFFF`; the flip bits are saved and re-applied at the end, so a
   tile and its flipped variants count as one tile.
2. **Expand animation closures.** If a tile is animated, all of its animation frames (recursively)
   are added to the layer's set. Frame ids are *tileset-local* in the Tiled format, so a tile and
   its frames must end up in the same tileset — keeping them in the same set from the start
   guarantees it.
3. **Handle broken references.** A GID that belongs to no tileset is reported and later remapped to
   the empty tile, as before.
4. **Named tiles pseudo-layer.** Tiles carrying a `name` property must survive optimization even if
   unused (WorkAdventure scripts can place them at runtime). Named tiles already used by some layer
   need nothing special; the remaining ones are gathered (with their animation closures) into one
   *pseudo-layer* that goes through clustering like any other layer, so they get packed wherever it
   is cheapest.

Output: one set of tile GIDs per layer.

## Pass 2 — Clustering (`src/Clustering.ts`)

This pass decides which layers share a tileset. It is a pure function, independent of any image
processing.

**Capacity.** A tileset texture is capped at `maxTextureSize` pixels (option
`output.tileset.size`, default 4096), i.e. `(maxTextureSize / tileSize)²` tiles — 16 384 tiles for
4096px textures with 32px tiles.

**Cost of a cluster.** For a cluster using `n` distinct tiles:

```
slots(n) = smallest power of 2 ≥ n     (the padded capacity of the texture)
cost(n)  = slots(n) + F
```

`F` is a small fixed per-tileset overhead (64 slots). It represents the real cost of one more
texture — an extra HTTP request, an extra GPU texture bind — and is what pushes many small layers
to share a tileset instead of each getting a tiny one.

**Greedy agglomerative merging.**

1. Start with one cluster per layer (layers with no tiles are skipped).
2. For every pair of clusters, compute
   `savings = cost(A) + cost(B) − cost(A ∪ B)`.
3. Merge the pair with the highest savings, provided the union still fits the capacity.
4. Repeat until no merge with positive savings exists.

Two properties make this simple greedy work well:

- Because `slots(a+b) ≤ slots(a) + slots(b)`, merging never increases the padded area. With
  `F > 0`, *any* feasible merge has positive savings — so clusters keep merging until they hit the
  capacity ceiling. On a map whose tiles all fit in one texture, the result is a single tileset
  shared by every layer: zero duplication, one download.
- When the map does *not* fit in one texture, the order of merges matters — and the greedy handles
  it: pairs sharing many tiles have much larger savings (the shared tiles are counted once instead
  of twice), so overlapping layers merge first. Layers end up split along low-overlap boundaries,
  which is exactly what minimizes duplication.

**Oversized layers.** If a *single layer* alone uses more tiles than the capacity, no clustering
can help. The layer is never split into two layers (that would break scripts referencing layers by
name); instead its cluster is flagged, a warning is printed, and pass 3 renders it with several
tilesets. Such a layer is not GPU-eligible; every other layer keeps the single-tileset guarantee.

**Determinism.** Ties are broken by layer order, members and clusters are sorted by layer index,
and tiles are later laid out in GID order — the same input always produces byte-identical output,
which keeps builds reproducible and cache-friendly.

## Pass 3 — Rendering and remapping (`src/Optimizer.ts`)

For each cluster, in order:

1. **Order the tiles** by original GID and assign local ids `0..n-1`.
2. **Choose the texture dimensions.** For `slots(n) = 2^e` slots, use `2^⌈e/2⌉` columns ×
   `2^⌊e/2⌋` rows of tiles: the smallest power-of-2 rectangle holding `n` tiles, as close to square
   as possible, width ≥ height. E.g. 300 tiles → 512 slots → 32×16 tiles → 1024×512 pixels.
3. **Render the texture.** Each tile is extracted from its source tileset image (honoring margin
   and spacing) and composited at `(local id mod columns, local id ÷ columns)`.
4. **Rebuild the tileset metadata.** Tileset-level properties and per-tile properties are copied
   onto the new tiles; animations are rewritten to the new local frame ids. `firstgid` values are
   assigned cumulatively across the output tilesets.
5. **Remap the layers.** Every cell of every member layer is rewritten:
   `new GID = cluster firstgid + local id`, with the original flip bits OR-ed back on top. A tile
   duplicated into two clusters legitimately gets a different GID in each — each layer uses its own
   cluster's mapping.

For an oversized cluster, step 1 additionally splits the tile list into capacity-sized chunks,
keeping each animation group (a tile plus its frames) whole within a chunk — duplicating a frame
across chunks in the rare case where two animations share frames — so animations never break.

## Worked example

A real 24-layer map (an airport hub) uses 2 023 distinct tiles out of 39 source tilesets:

- With the default 4096px cap, all layers cluster together: **one single 2048×1024 texture**
  (2 023 ≤ 2 048 slots), every layer GPU-eligible, zero duplicated tiles, 1.2 % padding waste.
- With the cap forced down to 512px (256 tiles per texture), the optimizer produces 12 textures:
  22 layers keep exactly one tileset each, and the 2 layers that individually exceed 256 tiles are
  warned about and split across several tilesets.
