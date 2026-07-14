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

At a high level, the optimizer walks every tile layer of the map (recursing into group layers),
collects the set of tiles that are actually referenced, extracts only those tiles from the source
tilesets and re-packs them into new, tightly-packed tileset images. The map data is then rewritten
in place so every tile reference points to its new location, and the source tilesets are discarded.

Rules:

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
  guaranteed to stay within a single tileset — the current tileset is flushed early rather than
  splitting an animation across two of them. Frame references are rewritten to the new local ids.
- **Named tiles are always kept.** Tiles carrying a `name` property are included in the new tileset
  even if they are not used anywhere on the map (WorkAdventure may reference them by name at runtime).
- **Tile and tileset properties are preserved.** Per-tile properties and tileset-level properties are
  carried over onto the corresponding tiles in the new tilesets.
- **Output is split into fixed-size "chunk" tilesets.** New tiles are packed into square tileset
  images capped at a configurable size (default `512px`, i.e. up to 16×16 = 256 tiles per chunk).
  Once a chunk is full a new one is started, and each rendered image is sized to the smallest square
  grid that fits its tiles.
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
