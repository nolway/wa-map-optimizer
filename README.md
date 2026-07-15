<h1>WA Map Optimizer 💪</h1>
<p>
  <a href="LICENSE.txt" target="_blank">
    <img alt="License: AGPL--3.0" src="https://img.shields.io/badge/License-AGPL--3.0-yellow.svg" />
  </a>
</p>

WorkAdventure Map Optimizer! Does your map need a diet?

## Requirements

- Node 16.15 <
-	Yarn 1.22 <

## Install

```sh
yarn add wa-map-optimizer
```

## Usage

```ts
import { optimize } from "wa-map-optimizer";

async function run() {
    await optimize("./example/map.json");
    console.log("Optimization finished");
}

run();
```

## Advanced usage

```ts
import { optimize } from "wa-map-optimizer";

async function run() {
    await optimize("./example/map.json", {
      tile: {
          size: 32,
      },
      logs: true,
      output: {
          path: "optimisation/new_map",
          map: {
            name: "awesome-map",
          },
          tileset: {
            prefix: "optimized",
            suffix: "tileset",
            // Maximum size (in pixels) of an output tileset texture.
            // Must be a power of 2. Default: 4096.
            size: 1024,
          }
      }
    });
    console.log("Optimization finished");
}

run();
```

## What it does

This package will optimize your Tiled map by removing unused tiles and creating a new tileset 
with only the used tiles. It will also update the map to use the new tileset.

A detailed, step-by-step description of the algorithm is available in
[docs/algorithm.md](docs/algorithm.md).

At a high level, the optimizer works in three passes:

1. **Analysis**: walk every tile layer of the map (recursing into group layers) and collect the set
   of tiles each layer actually references.
2. **Clustering**: group layers so that each group's tiles fit together in a single tileset texture.
3. **Rendering**: extract the tiles from the source tilesets, re-pack them into one new tileset
   image per group, and rewrite the map data so every tile reference points to its new location.
   The source tilesets are discarded.

Rules:

- **Each layer references a single tileset.** This is the requirement for Phaser 4's
  `TilemapGPULayer`: a GPU-rendered layer must source all of its tiles from one tileset. The
  optimizer guarantees it by construction — layers are clustered, and each cluster produces exactly
  one tileset holding the union of its layers' tiles. A tileset may be shared by several layers,
  and a tile used by layers living in different clusters is duplicated into both tilesets (the
  clustering minimizes how often this happens).
- **Tileset textures have power-of-2 dimensions.** Output images are rectangular power-of-2
  textures (e.g. 2048x1024), as close to square as possible, capped at a configurable maximum size
  (`output.tileset.size`, default `4096`). The clustering packs as many layers as possible into
  each texture within that cap.
- **A single layer bigger than one tileset is never split.** If one layer alone uses more tiles
  than fit in the maximum texture size, the optimizer warns and renders that layer with several
  tilesets: the map stays correct, but that layer will not be eligible for GPU rendering.

- **Only referenced tiles are kept.** Tiles that are never placed on any tile layer are dropped
  from the output. Empty tiles (id `0`) are ignored.
- **Tiles are de-duplicated.** Each distinct source tile is extracted only once, no matter how many
  times it appears on the map; every reference is remapped to the single new tile id.
- **Flipped and rotated tiles are handled.** Tiled encodes horizontal/vertical/diagonal flips in the
  top bits (29–31) of the tile id. The optimizer strips these flip bits before de-duplicating, so a
  tile and all its flipped variants share a single extracted tile, then re-applies the flip bits to
  the new id.
- **Animated tiles are kept whole.** When a tile is animated, all of its animation frames are pulled
  into the output (even frames that are never placed directly on the map), and the whole animation is
  guaranteed to stay within the same tileset as its base tile (frame ids are tileset-local in the
  Tiled format). Frame references are rewritten to the new local ids.
- **Named tiles are always kept.** Tiles carrying a `name` property are included in the new tileset
  even if they are not used anywhere on the map (WorkAdventure may reference them by name at runtime).
- **Tile and tileset properties are preserved.** Per-tile properties and tileset-level properties are
  carried over onto the corresponding tiles in the new tilesets.
- **Tileset images can optionally be compressed** with pngquant (via the `output.tileset.compress`
  option) to further shrink the output.

## Author

👤 **Nolway (Alexis Faizeau)**

-   Website: [alexis-faizeau.com](https://www.alexis-faizeau.com)
-   Github: [@Nolway](https://github.com/Nolway)
-   LinkedIn: [@alexis-faizeau](https://linkedin.com/in/alexis-faizeau)

## Show your support

Give a ⭐️ if this project helped you!

## 📝 License

Copyright © 2022 [Nolway(Alexis Faizeau)](https://github.com/Nolway).<br />
This project is [AGPL--3.0](LICENSE.txt) licensed.
