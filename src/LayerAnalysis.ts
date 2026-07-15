import { ITiledMapEmbeddedTileset, ITiledMapLayer, ITiledMapTile } from "@workadventure/tiled-map-type-guard";

/** Bits 0-28 of a Tiled GID: the actual tile id */
export const GID_MASK = 0x1fffffff;
/** Bits 29-31 of a Tiled GID: diagonal / vertical / horizontal flip flags */
export const FLIP_MASK = 0xe0000000;

export function stripFlipBits(rawGid: number): { gid: number; flipBits: number } {
    return {
        gid: (rawGid & GID_MASK) >>> 0,
        flipBits: (rawGid & FLIP_MASK) >>> 0,
    };
}

export function applyFlipBits(gid: number, flipBits: number): number {
    return (gid | flipBits) >>> 0;
}

export type LayerTileSet = {
    /** Undefined for the pseudo-layer holding named tiles that no layer uses */
    layer?: ITiledMapLayer;
    name: string;
    /** Unflipped GIDs used by the layer, animation closures included */
    tiles: Set<number>;
};

/** Resolves GIDs to their source tileset and per-tile data */
export class TilesetIndex {
    private readonly entries: { firstgid: number; lastgid: number; tileset: ITiledMapEmbeddedTileset }[] = [];

    constructor(tilesets: ITiledMapEmbeddedTileset[]) {
        for (const tileset of tilesets) {
            if (tileset.firstgid === undefined) {
                throw new Error(`firstgid property is undefined on ${tileset.name} tileset`);
            }

            if (tileset.tilecount === undefined) {
                throw new Error(`tilecount property is undefined on ${tileset.name} tileset`);
            }

            this.entries.push({
                firstgid: tileset.firstgid,
                lastgid: tileset.firstgid + tileset.tilecount - 1,
                tileset: tileset,
            });
        }
    }

    public getTileset(gid: number): ITiledMapEmbeddedTileset | undefined {
        return this.entries.find((entry) => gid >= entry.firstgid && gid <= entry.lastgid)?.tileset;
    }

    public getTileData(gid: number): ITiledMapTile | undefined {
        const entry = this.entries.find((entry) => gid >= entry.firstgid && gid <= entry.lastgid);
        return entry?.tileset.tiles?.find((tile) => tile.id === gid - entry.firstgid);
    }
}

/**
 * Adds the given tile and its animation closure (every animation frame, recursively) to `into`.
 * Frame ids are tileset-local in Tiled, so a tile and its frames must always land in the same
 * output tileset: keeping them in the same set guarantees it.
 */
export function expandTileClosure(gid: number, tilesetIndex: TilesetIndex, into: Set<number>): void {
    if (into.has(gid)) {
        return;
    }

    into.add(gid);

    const tileset = tilesetIndex.getTileset(gid);
    const firstgid = tileset?.firstgid;

    if (firstgid === undefined) {
        return;
    }

    const tileData = tilesetIndex.getTileData(gid);

    if (!tileData?.animation) {
        return;
    }

    for (const frame of tileData.animation) {
        expandTileClosure(firstgid + frame.tileid, tilesetIndex, into);
    }
}

/**
 * Returns the tile group that must stay within a single tileset image: the tile itself plus its
 * animation closure. Used when an oversized layer has to be split across several tilesets.
 */
export function animationGroup(gid: number, tilesetIndex: TilesetIndex): number[] {
    const group = new Set<number>();
    expandTileClosure(gid, tilesetIndex, group);
    return [...group].sort((a, b) => a - b);
}

/**
 * Pass 1: collects, for every tile layer of the map (recursing into groups), the set of unflipped
 * GIDs it uses, expanded with animation closures. GIDs pointing to no source tileset are reported
 * in `unknownGids` and excluded from the sets (they will be remapped to 0, as before).
 */
export function collectLayerTileSets(
    layers: ITiledMapLayer[],
    tilesetIndex: TilesetIndex
): { layerTileSets: LayerTileSet[]; unknownGids: Set<number> } {
    const layerTileSets: LayerTileSet[] = [];
    const unknownGids = new Set<number>();

    const walk = (walkedLayers: ITiledMapLayer[]) => {
        for (const layer of walkedLayers) {
            if (layer.type === "group") {
                if (layer.layers) {
                    walk(layer.layers);
                }
                continue;
            }

            if (layer.type !== "tilelayer" || !layer.data || typeof layer.data === "string") {
                continue;
            }

            const tiles = new Set<number>();

            for (const rawGid of layer.data) {
                if (rawGid === 0) {
                    continue;
                }

                const { gid } = stripFlipBits(Number(rawGid));

                if (tiles.has(gid) || unknownGids.has(gid)) {
                    continue;
                }

                if (!tilesetIndex.getTileset(gid)) {
                    unknownGids.add(gid);
                    continue;
                }

                expandTileClosure(gid, tilesetIndex, tiles);
            }

            layerTileSets.push({
                layer: layer,
                name: layer.name ?? "unnamed layer",
                tiles: tiles,
            });
        }
    };

    walk(layers);

    return { layerTileSets, unknownGids };
}

/**
 * Named tiles (tiles carrying a "name" property) must always be present in the output because
 * WorkAdventure scripts can reference them at runtime. Named tiles already used by a layer need
 * nothing special; this returns the remaining ones (closures included) so they can be packed as a
 * pseudo-layer participating in the clustering.
 */
export function collectUnusedNamedTiles(
    tilesets: ITiledMapEmbeddedTileset[],
    tilesetIndex: TilesetIndex,
    usedTiles: ReadonlySet<number>
): Set<number> {
    const namedTiles = new Set<number>();

    for (const tileset of tilesets) {
        if (!tileset.tiles || tileset.firstgid === undefined) {
            continue;
        }

        for (const tile of tileset.tiles) {
            const gid = tileset.firstgid + tile.id;

            if (usedTiles.has(gid) || namedTiles.has(gid)) {
                continue;
            }

            if (tile.properties?.find((property) => property.name === "name")) {
                expandTileClosure(gid, tilesetIndex, namedTiles);
            }
        }
    }

    return namedTiles;
}
