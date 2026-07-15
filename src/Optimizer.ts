import {
    ITiledMap,
    ITiledMapEmbeddedTileset,
    ITiledMapLayer,
    ITiledMapTile,
} from "@workadventure/tiled-map-type-guard";
import sharp, { Sharp } from "sharp";
import { Cluster, clusterLayers, slotsFor } from "./Clustering.js";
import {
    animationGroup,
    applyFlipBits,
    collectLayerTileSets,
    collectUnusedNamedTiles,
    stripFlipBits,
    TilesetIndex,
} from "./LayerAnalysis.js";
import { LogLevel, OptimizeBufferOptions } from "./guards/libGuards.js";

sharp.cache(false);

/**
 * Per-tileset overhead used by the clustering cost function, in tile slots. It stands for the cost
 * of one more HTTP request / GPU texture, and pushes small disjoint layers to share a tileset.
 */
const TILESET_FIXED_COST = 64;

/**
 * The optimizer guarantees that each tile layer references tiles from a single output tileset
 * (Phaser 4 TilemapGPULayer requirement), by clustering layers and rendering one tileset per
 * cluster. It works in three passes:
 * 1. Analysis: collect the set of tiles used by each layer (animation closures included).
 * 2. Clustering: group layers so that each group's tile union fits in one power-of-2 texture.
 * 3. Rendering: draw one tileset image per cluster and remap every layer's tile ids.
 */
export class Optimizer {
    private optimizedMap: ITiledMap;
    private tileSize: number;
    private maxTextureSize: number;
    private tilesetCapacity: number;
    private tilesetPrefix: string;
    private tilesetSuffix?: string;
    private logLevel: LogLevel;
    // Each source tileset decoded to raw RGBA pixels exactly once. Tiles are then sliced out of
    // these buffers with plain memory copies instead of a per-tile sharp/libvips extract() call.
    private readonly sourceRaws = new Map<ITiledMapEmbeddedTileset, { data: Buffer; width: number; height: number }>();

    constructor(
        map: ITiledMap,
        private readonly tilesetsBuffers: Map<ITiledMapEmbeddedTileset, Sharp>,
        options: OptimizeBufferOptions | undefined = undefined,
        private readonly outputPath: string
    ) {
        this.optimizedMap = map;
        this.tileSize = options?.tile?.size ?? 32;
        this.maxTextureSize = options?.output?.tileset?.size ?? 4096;
        this.tilesetPrefix = options?.output?.tileset?.prefix ?? "chunk";
        this.tilesetSuffix = options?.output?.tileset?.suffix;
        this.logLevel = options?.logs ?? LogLevel.NORMAL;

        if (this.maxTextureSize < this.tileSize) {
            throw new Error(
                `Max tileset size (${this.maxTextureSize}) cannot be smaller than the tile size (${this.tileSize})`
            );
        }

        const maxColumns = Math.floor(this.maxTextureSize / this.tileSize);
        this.tilesetCapacity = maxColumns * maxColumns;

        if (this.logLevel && (this.tileSize & (this.tileSize - 1)) !== 0) {
            console.warn(
                `Tile size ${this.tileSize} is not a power of 2: output tileset images will not have power-of-2 dimensions`
            );
        }

        for (const tileset of [...tilesetsBuffers.keys()]) {
            if (tileset.tileheight !== this.tileSize || tileset.tilewidth !== this.tileSize) {
                throw Error(`Tileset ${tileset.name} not compatible! Accept only ${this.tileSize} tile size`);
            }
        }
    }

    public async optimize(): Promise<ITiledMap> {
        if (this.logLevel) {
            console.log("Start tiles optimization...");
        }

        const sourceTilesets = [...this.tilesetsBuffers.keys()];
        const tilesetIndex = new TilesetIndex(sourceTilesets);

        // Pass 1: analysis
        const { layerTileSets, unknownGids } = collectLayerTileSets(this.optimizedMap.layers, tilesetIndex);

        if (this.logLevel) {
            for (const gid of unknownGids) {
                console.error(`${gid} undefined! Corrupted layers or undefined in tilesets`);
                console.error("This tile has been replaced by an empty tile");
            }
        }

        const usedTiles = new Set<number>();
        for (const layerTileSet of layerTileSets) {
            for (const gid of layerTileSet.tiles) {
                usedTiles.add(gid);
            }
        }

        const namedTiles = collectUnusedNamedTiles(sourceTilesets, tilesetIndex, usedTiles);
        if (namedTiles.size > 0) {
            layerTileSets.push({ name: "<named tiles>", tiles: namedTiles });
            for (const gid of namedTiles) {
                usedTiles.add(gid);
            }
        }

        // Pass 2: clustering
        const clusters = clusterLayers(
            layerTileSets.map((layerTileSet, index) => ({
                index: index,
                name: layerTileSet.name,
                tiles: layerTileSet.tiles,
            })),
            this.tilesetCapacity,
            TILESET_FIXED_COST
        );

        for (const cluster of clusters) {
            if (cluster.oversized && this.logLevel) {
                console.warn(
                    `Layer "${cluster.members[0].name}" uses ${cluster.tiles.size} tiles, more than the ${this.tilesetCapacity} fitting in a single ${this.maxTextureSize}x${this.maxTextureSize} tileset.`
                );
                console.warn(
                    "It will be split across several tilesets and will NOT be eligible for GPU rendering. Consider raising output.tileset.size or simplifying the layer."
                );
            }
        }

        // Pass 3: rendering & remapping
        await this.loadSourceRaws();

        const layerMappings = new Map<ITiledMapLayer, Map<number, number>>();
        const newTilesets: ITiledMapEmbeddedTileset[] = [];
        let firstgid = 1;
        let renderedTileCount = 0;

        for (const cluster of clusters) {
            const chunks = this.splitIntoChunks(cluster, tilesetIndex);
            const clusterMapping = new Map<number, number>();

            for (const gids of chunks) {
                const localIds = new Map<number, number>();

                for (const [localId, gid] of gids.entries()) {
                    localIds.set(gid, localId);
                    clusterMapping.set(gid, firstgid + localId);
                }

                const tileset = this.buildTilesetData(gids, localIds, firstgid, newTilesets.length + 1, tilesetIndex);
                await this.renderTileset(gids, tileset, tilesetIndex);
                newTilesets.push(tileset);

                if (this.logLevel) {
                    const layerNames = cluster.members.map((member) => member.name).join(", ");
                    console.log(
                        `${tileset.name}: ${tileset.imagewidth ?? 0}x${tileset.imageheight ?? 0}px, ${
                            gids.length
                        } tiles — layers: ${layerNames}`
                    );
                }

                // Advance by the full image-grid capacity so the reserved GID range matches the
                // image dimensions Phaser reads. renderedTileCount still counts real tiles.
                firstgid += slotsFor(gids.length);
                renderedTileCount += gids.length;
            }

            for (const member of cluster.members) {
                const layer = layerTileSets[member.index].layer;
                if (layer) {
                    layerMappings.set(layer, clusterMapping);
                }
            }
        }

        this.assertNoOverlappingGidRanges(newTilesets);

        this.remapLayers(this.optimizedMap.layers, layerMappings);
        this.optimizedMap.tilesets = newTilesets;

        if (this.logLevel) {
            const duplicated = renderedTileCount - usedTiles.size;
            console.log(
                `Tiles optimization has been done: ${newTilesets.length} tileset(s), ${usedTiles.size} unique tiles, ${duplicated} duplicated`
            );
        }

        return this.optimizedMap;
    }

    /**
     * A regular cluster fits in a single tileset. An oversized cluster (a single layer using more
     * tiles than the capacity) is split into several tilesets; animation groups are kept whole
     * within a chunk (frame ids are tileset-local), duplicating frames across chunks if needed.
     */
    private splitIntoChunks(cluster: Cluster, tilesetIndex: TilesetIndex): number[][] {
        const sorted = [...cluster.tiles].sort((a, b) => a - b);

        if (!cluster.oversized) {
            return [sorted];
        }

        const chunks: number[][] = [];
        let current: number[] = [];
        let currentSet = new Set<number>();
        const placed = new Set<number>();

        for (const gid of sorted) {
            // Closures are transitively closed, so a tile placed as part of a previous group
            // already sits in the same chunk as its own animation frames.
            if (placed.has(gid)) {
                continue;
            }

            const group = animationGroup(gid, tilesetIndex);
            let toAdd = group.filter((groupGid) => !currentSet.has(groupGid));

            if (current.length > 0 && current.length + toAdd.length > this.tilesetCapacity) {
                chunks.push(current);
                current = [];
                currentSet = new Set();
                toAdd = group;
            }

            for (const groupGid of toAdd) {
                current.push(groupGid);
                currentSet.add(groupGid);
                placed.add(groupGid);
            }
        }

        if (current.length > 0) {
            chunks.push(current);
        }

        return chunks;
    }

    private buildTilesetData(
        gids: number[],
        localIds: Map<number, number>,
        firstgid: number,
        tilesetNumber: number,
        tilesetIndex: TilesetIndex
    ): ITiledMapEmbeddedTileset {
        // Smallest rectangular power-of-2 texture holding the tiles, as close to square as
        // possible, width >= height (e.g. 300 tiles -> 512 slots -> 32x16 tiles -> 1024x512px).
        const slots = slotsFor(gids.length);
        const exponent = Math.log2(slots);
        const columns = Math.pow(2, Math.ceil(exponent / 2));
        const rows = slots / columns;

        const tiles: ITiledMapTile[] = [];

        for (const [localId, gid] of gids.entries()) {
            const sourceTileset = tilesetIndex.getTileset(gid);

            if (!sourceTileset || sourceTileset.firstgid === undefined) {
                throw new Error(`No source tileset found for tile ${gid}`);
            }

            const tileData = tilesetIndex.getTileData(gid);
            const properties = [...(sourceTileset.properties ?? []), ...(tileData?.properties ?? [])];
            const newTile: ITiledMapTile = { id: localId };

            if (properties.length > 0) {
                newTile.properties = properties;
            }

            if (tileData?.animation) {
                const sourceFirstgid = sourceTileset.firstgid;
                newTile.animation = tileData.animation.map((frame) => {
                    const frameLocalId = localIds.get(sourceFirstgid + frame.tileid);

                    if (frameLocalId === undefined) {
                        throw new Error(`Undefined tile in animation for ${sourceFirstgid + frame.tileid}`);
                    }

                    return {
                        duration: frame.duration,
                        tileid: frameLocalId,
                    };
                });
            }

            if (newTile.properties || newTile.animation) {
                tiles.push(newTile);
            }
        }

        return {
            columns: columns,
            firstgid: firstgid,
            image: `${this.tilesetPrefix}-${tilesetNumber}${this.tilesetSuffix ? "-" + this.tilesetSuffix : ""}.png`,
            imageheight: rows * this.tileSize,
            imagewidth: columns * this.tileSize,
            margin: 0,
            name: `Chunk ${tilesetNumber}`,
            properties: [],
            spacing: 0,
            // Reserve the full image-grid capacity as GIDs (columns*rows === slots), not just the
            // used tile count. Phaser derives a tileset's tile count from the image dimensions and
            // ignores this value, so a smaller tilecount would make consecutive tilesets' GID
            // ranges overlap and silently drop tiles on classic TilemapLayer rendering.
            tilecount: columns * rows,
            tileheight: this.tileSize,
            tilewidth: this.tileSize,
            tiles: tiles,
        };
    }

    private async renderTileset(
        gids: number[],
        tileset: ITiledMapEmbeddedTileset,
        tilesetIndex: TilesetIndex
    ): Promise<void> {
        if (this.logLevel === LogLevel.VERBOSE) {
            console.log(`Rendering of ${tileset.name} tileset...`);
        }

        if (tileset.imagewidth === undefined || tileset.imageheight === undefined) {
            throw new Error(`Undefined image size on ${tileset.name} tileset`);
        }

        // The tiles form a regular, non-overlapping grid on a transparent canvas, so "compositing"
        // them is really just placing each tile's pixels into its own cell — a memory copy. Handing
        // thousands of tiles to sharp/libvips composite() instead makes it run its general N-layer
        // alpha compositor, whose cost scales with the number of layers (per-tile bookkeeping), not
        // the pixels moved. Likewise, extracting each tile with a per-tile sharp extract() call is
        // thousands of round-trips into libvips over source pixels we already hold in memory. We
        // copy each tile's rows straight from the cached source buffer into the destination buffer
        // and let sharp encode the finished image exactly once.
        const channels = 4;
        const width = tileset.imagewidth;
        const height = tileset.imageheight;
        const dest = Buffer.alloc(width * height * channels); // zero-filled == fully transparent

        let x = 0;
        let y = 0;

        for (const gid of gids) {
            if (x === width) {
                y += this.tileSize;
                x = 0;
            }

            const sourceTileset = tilesetIndex.getTileset(gid);
            if (!sourceTileset) {
                throw new Error(`No source tileset found for tile ${gid}`);
            }

            const source = this.sourceRaws.get(sourceTileset);
            if (!source) {
                throw new Error(`No decoded source pixels for tileset ${sourceTileset.name}`);
            }

            const { left, top } = this.tileLocation(sourceTileset, gid);

            // sharp's extract() used to throw on an out-of-range crop; Buffer.copy() would instead
            // silently truncate and emit a corrupt tile. Keep the loud failure for bad metadata.
            if (left < 0 || top < 0 || left + this.tileSize > source.width || top + this.tileSize > source.height) {
                throw new Error(
                    `Tile ${gid} maps to an out-of-bounds source rect [${left},${top} +${this.tileSize}] in the ${source.width}x${source.height} tileset ${sourceTileset.name}`
                );
            }

            this.blitTile(source, left, top, dest, width, x, y);

            x += this.tileSize;
        }

        await sharp(dest, { raw: { width, height, channels } }).png().toFile(`${this.outputPath}/${tileset.image}`);

        if (this.logLevel === LogLevel.VERBOSE) {
            console.log(`${tileset.name} tileset has been rendered`);
        }
    }

    /**
     * Copy one tileSize×tileSize RGBA tile from a source image buffer into a destination image
     * buffer, row by row. This is a straight memory copy, not an alpha composite: output tiles sit
     * on a non-overlapping grid over a transparent canvas, so each destination cell is written
     * exactly once and there is nothing to blend against. See renderTileset for why that matters.
     */
    private blitTile(
        source: { data: Buffer; width: number },
        srcLeft: number,
        srcTop: number,
        dest: Buffer,
        destWidth: number,
        destLeft: number,
        destTop: number
    ): void {
        const channels = 4;
        const rowBytes = this.tileSize * channels;
        const srcStride = source.width * channels;
        const destStride = destWidth * channels;

        for (let row = 0; row < this.tileSize; row++) {
            const srcStart = (srcTop + row) * srcStride + srcLeft * channels;
            const destStart = (destTop + row) * destStride + destLeft * channels;
            source.data.copy(dest, destStart, srcStart, srcStart + rowBytes);
        }
    }

    /**
     * Decode every source tileset image to raw RGBA pixels exactly once and cache it. ensureAlpha()
     * forces a uniform 4-channel layout (opaque alpha for RGB sources) so tiles can be sliced with a
     * single fixed stride, and matches the transparent-over-RGBA canvas the tiles are drawn onto.
     */
    private async loadSourceRaws(): Promise<void> {
        for (const [tileset, sharpObject] of this.tilesetsBuffers) {
            const { data, info } = await sharpObject.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

            // The render loop assumes a fixed 4-channel (RGBA) stride; ensureAlpha() guarantees it
            // for RGB/RGBA sources but not e.g. a grayscale image (which yields 2 channels).
            if (info.channels !== 4) {
                throw new Error(
                    `Tileset ${tileset.name} decoded to ${info.channels} channels after ensureAlpha(), expected 4 (RGBA). Is it a grayscale image?`
                );
            }

            // tileLocation() derives tile columns from the metadata width, while the copy loop uses
            // the decoded width for its stride. If they disagree, tiles would be read from the wrong
            // offsets — silently, since the reads could still land in bounds. Fail loudly instead.
            if (tileset.imagewidth !== info.width || tileset.imageheight !== info.height) {
                throw new Error(
                    `Tileset ${tileset.name} metadata size ${tileset.imagewidth ?? "?"}x${
                        tileset.imageheight ?? "?"
                    } does not match the decoded image ${info.width}x${info.height}`
                );
            }

            this.sourceRaws.set(tileset, { data, width: info.width, height: info.height });
        }
    }

    /**
     * Pixel coordinates of a tile's top-left corner within its source image, honouring the source
     * tileset's margin and inter-tile spacing.
     */
    private tileLocation(tileset: ITiledMapEmbeddedTileset, gid: number): { left: number; top: number } {
        if (!tileset.imagewidth) {
            throw new Error(`imagewidth property is undefined on ${tileset.name} tileset`);
        }

        if (tileset.firstgid === undefined) {
            throw new Error(`firstgid property is undefined on ${tileset.name} tileset`);
        }

        const spacing = tileset.spacing ?? 0;
        const margin = tileset.margin ?? 0;
        const tileSizeSpaced = this.tileSize + spacing;
        const columns = Math.floor((tileset.imagewidth - margin + spacing) / tileSizeSpaced);
        const localId = gid - tileset.firstgid;
        const left = margin + (localId % columns) * tileSizeSpaced;
        const top = margin + Math.floor(localId / columns) * tileSizeSpaced;

        return { left, top };
    }

    /**
     * Phaser derives a tileset's tile count from its image dimensions and ignores the JSON
     * `tilecount`, so a tileset effectively owns `[firstgid, firstgid + columns*rows)`. If two of
     * those ranges intersect, the last one written wins the overlap and tiles belonging to the
     * other tileset silently render transparent. The emit loop reserves the full image-grid
     * capacity per tileset precisely to avoid this; assert the invariant so any regression fails
     * loudly instead of dropping furniture.
     */
    private assertNoOverlappingGidRanges(tilesets: ITiledMapEmbeddedTileset[]): void {
        const ranges = tilesets
            .map((tileset) => {
                const columns = tileset.columns ?? 0;
                const rows = (tileset.imageheight ?? 0) / this.tileSize;
                const start = tileset.firstgid ?? 0;
                return { name: tileset.name, start, end: start + columns * rows };
            })
            .sort((a, b) => a.start - b.start);

        for (let i = 1; i < ranges.length; i++) {
            const prev = ranges[i - 1];
            const curr = ranges[i];
            if (curr.start < prev.end) {
                throw new Error(
                    `Overlapping tileset GID ranges: "${prev.name}" [${prev.start}, ${prev.end}) intersects "${curr.name}" [${curr.start}, ${curr.end})`
                );
            }
        }
    }

    private remapLayers(layers: ITiledMapLayer[], layerMappings: Map<ITiledMapLayer, Map<number, number>>): void {
        for (const layer of layers) {
            if (layer.type === "group") {
                if (layer.layers) {
                    this.remapLayers(layer.layers, layerMappings);
                }
                continue;
            }

            if (layer.type !== "tilelayer" || !layer.data) {
                continue;
            }

            if (typeof layer.data === "string") {
                if (this.logLevel) {
                    console.warn(
                        `Layer "${layer.name}" data is string-encoded and cannot be optimized: its tile ids will be broken in the output`
                    );
                }
                continue;
            }

            const mapping = layerMappings.get(layer);

            for (let i = 0; i < layer.data.length; i++) {
                const rawGid = Number(layer.data[i]);

                if (rawGid === 0) {
                    continue;
                }

                const { gid, flipBits } = stripFlipBits(rawGid);
                const newGid = mapping?.get(gid);

                if (newGid === undefined) {
                    layer.data[i] = 0;
                    continue;
                }

                layer.data[i] = applyFlipBits(newGid, flipBits);
            }
        }
    }
}
