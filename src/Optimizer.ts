import {
    ITiledMap,
    ITiledMapEmbeddedTileset,
    ITiledMapLayer,
    ITiledMapTile,
} from "@workadventure/tiled-map-type-guard";
import { PNG } from "pngjs";
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

                firstgid += gids.length;
                renderedTileCount += gids.length;
            }

            for (const member of cluster.members) {
                const layer = layerTileSets[member.index].layer;
                if (layer) {
                    layerMappings.set(layer, clusterMapping);
                }
            }
        }

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
            tilecount: gids.length,
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

        const tileBuffers = await Promise.all(
            gids.map((gid) => {
                const sourceTileset = tilesetIndex.getTileset(gid);

                if (!sourceTileset) {
                    throw new Error(`No source tileset found for tile ${gid}`);
                }

                return this.extractTile(sourceTileset, gid);
            })
        );

        const emptyBuffer = await this.generateNewTilesetBuffer(tileset.imagewidth, tileset.imageheight);
        const sharpComposites: sharp.OverlayOptions[] = [];

        let x = 0;
        let y = 0;

        for (const tileBuffer of tileBuffers) {
            if (x === tileset.imagewidth) {
                y += this.tileSize;
                x = 0;
            }

            sharpComposites.push({
                input: tileBuffer,
                top: y,
                left: x,
            });

            x += this.tileSize;
        }

        await sharp(emptyBuffer).composite(sharpComposites).toFile(`${this.outputPath}/${tileset.image}`);

        if (this.logLevel === LogLevel.VERBOSE) {
            console.log(`${tileset.name} tileset has been rendered`);
        }
    }

    private async generateNewTilesetBuffer(width: number, height: number): Promise<Buffer> {
        const newFile = new PNG({
            width: width,
            height: height,
        });

        return await newFile.pack().pipe(sharp()).toBuffer();
    }

    private async extractTile(tileset: ITiledMapEmbeddedTileset, gid: number): Promise<Buffer> {
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

        const sharpObject = this.tilesetsBuffers.get(tileset);

        if (!sharpObject) {
            throw new Error("Undefined sharp object");
        }

        return await sharpObject
            .extract({
                left: left,
                top: top,
                width: this.tileSize,
                height: this.tileSize,
            })
            .toBuffer();
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
