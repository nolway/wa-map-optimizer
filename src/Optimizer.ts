import { PNG } from "pngjs";
import sharp from "sharp";
import { OptimizeBufferOptions, OptimizedMapFiles } from "./guards/libGuards";
import { Map as MapFormat, MapTileset, MapTilesetTile } from "./guards/mapGuards";

sharp.cache(false);

export class Optimizer {
    private optimizedMap: MapFormat;
    private optimizedTiles: Map<number, number>;
    private optimizedTilesets: Map<MapTileset, Buffer>;
    private currentTilesetOptimization: MapTileset;
    private currentExtractedTiles: Promise<Buffer>[];
    private tileSize: number;
    private tilesetMaxColumns: number;
    private tilesetMaxLines: number;
    private allowLogs: boolean;

    constructor(
        map: MapFormat,
        private readonly tilesetsBuffers: Map<MapTileset, Buffer>,
        options: OptimizeBufferOptions | undefined = undefined
    ) {
        this.optimizedMap = map;
        this.optimizedTiles = new Map<number, number>();
        this.optimizedTilesets = new Map<MapTileset, Buffer>();
        this.currentTilesetOptimization = this.generateNextTileset();
        this.currentExtractedTiles = [];
        this.tileSize = options?.tile?.size ?? 32;
        this.tilesetMaxColumns = (options?.output?.tileset?.size?.width ?? 2048) / this.tileSize;
        this.tilesetMaxLines = (options?.output?.tileset?.size?.height ?? 2048) / this.tileSize;
        this.allowLogs = options?.logs ?? true;

        for (const tileset of [...tilesetsBuffers.keys()]) {
            if (tileset.tileheight !== this.tileSize || tileset.tilewidth !== this.tileSize) {
                throw Error(`Tileset ${tileset.name} not compatible! Accept only ${this.tileSize} tile size`);
            }
        }
    }

    public async optimize(): Promise<OptimizedMapFiles> {
        if (this.allowLogs) {
            console.log("Start map optimization...");
        }

        for (let i = 0; i < this.optimizedMap.layers.length; i++) {
            const layer = this.optimizedMap.layers[i];

            if (!layer.data) {
                continue;
            }

            for (let y = 0; y < layer.data.length; y++) {
                const tileId = layer.data[y];

                if (tileId === 0) {
                    continue;
                }

                await this.checkCurrentTileset();

                const newTileId = this.optimizeNewTile(tileId);

                layer.data[y] = newTileId;
            }
        }

        await this.currentTilesetRendering();

        const tilesetsBuffer = new Map<string, Buffer>();
        this.optimizedMap.tilesets = [];

        for (const currentTileset of this.optimizedTilesets) {
            this.optimizedMap.tilesets.push(currentTileset[0]);
            tilesetsBuffer.set(currentTileset[0].image, currentTileset[1]);
        }

        if (this.allowLogs) {
            console.log("Map optimization has been done");
        }

        return {
            map: this.optimizedMap,
            tilesetsBuffer,
        };
    }

    private generateNextTileset(): MapTileset {
        if (this.allowLogs) {
            console.log("Generate a new tileset data");
        }

        const tilesetCount = this.optimizedTilesets.size + 1;
        return {
            columns: 1,
            firstgid: this.optimizedTiles.size + 1,
            image: `chunk-${tilesetCount}.png`,
            imageheight: 0,
            imagewidth: 0,
            margin: 0,
            name: `Chunk ${tilesetCount}`,
            properties: [],
            spacing: 0,
            tilecount: 0,
            tileheight: this.tileSize,
            tilewidth: this.tileSize,
            tiles: [],
        };
    }

    private async generateNewTilesetBuffer(width: number, height: number): Promise<Buffer> {
        const newFile = new PNG({
            width: width,
            height: height,
        });

        return await newFile.pack().pipe(sharp()).toBuffer();
    }

    private optimizeNewTile(tileId: number): number {
        const existantNewTileId = this.optimizedTiles.get(tileId);

        if (existantNewTileId) {
            return existantNewTileId;
        }

        if (this.allowLogs) {
            console.log(`${tileId} tile is optimizing...`);
        }

        let oldTileset: MapTileset | undefined;

        for (const tileset of this.tilesetsBuffers.keys()) {
            if (tileset.firstgid <= tileId && tileset.firstgid + tileset.tilecount > tileId) {
                oldTileset = tileset;
                break;
            }
        }

        if (!oldTileset) {
            throw Error("Corrupted layers or undefined tileset");
        }

        const newTileId = this.optimizedTiles.size + 1;

        this.optimizedTiles.set(tileId, newTileId);

        let newTileData: MapTilesetTile | undefined = undefined;

        this.currentExtractedTiles.push(this.extractTile(oldTileset, tileId));

        if (oldTileset.properties) {
            newTileData = {
                id: newTileId,
                properties: oldTileset.properties,
            };
            this.currentTilesetOptimization.tiles?.push(newTileData);
        }

        if (!oldTileset.tiles) {
            return newTileId;
        }

        const tileData = oldTileset.tiles.find((tile) => tile.id === tileId);

        if (!tileData) {
            return newTileId;
        }

        if (!newTileData) {
            newTileData = {
                id: newTileId,
            };
            this.currentTilesetOptimization.tiles?.push(newTileData);
        }

        if (tileData.properties) {
            newTileData.properties
                ? newTileData.properties.push(...tileData.properties)
                : (newTileData.properties = tileData.properties);
        }

        if (tileData.animation) {
            newTileData.animation = [];
            for (const frame of tileData.animation) {
                if (frame.tileid === 0) {
                    newTileData.animation.push({
                        duration: frame.duration,
                        tileid: 0,
                    });
                    continue;
                }

                newTileData.animation.push({
                    duration: frame.duration,
                    tileid: this.optimizeNewTile(frame.tileid),
                });
            }
        }

        return newTileId;
    }

    private async extractTile(tileset: MapTileset, tileId: number): Promise<Buffer> {
        const tilesetColumns = tileset.imagewidth / this.tileSize;
        const tilesetTileId = tileId - tileset.firstgid + 1;

        const estimateLeft = tilesetTileId <= tilesetColumns ? tilesetTileId : tilesetTileId % tilesetColumns;
        const leftStartPoint = (estimateLeft === 0 ? tilesetColumns : estimateLeft) * this.tileSize - this.tileSize;
        const topStartPoint =
            tilesetTileId <= tilesetColumns
                ? 0
                : Math.floor(tilesetTileId / tilesetColumns) * this.tileSize - this.tileSize;

        return await sharp(this.tilesetsBuffers.get(tileset))
            .extract({
                left: leftStartPoint,
                top: topStartPoint,
                width: this.tileSize,
                height: this.tileSize,
            })
            .toBuffer();
    }

    private async checkCurrentTileset(): Promise<void> {
        if (this.currentExtractedTiles.length < this.tilesetMaxColumns * this.tilesetMaxLines) {
            return;
        }
        await this.currentTilesetRendering();
    }

    private async currentTilesetRendering(): Promise<void> {
        if (this.allowLogs) {
            console.log(`Rendering of ${this.currentTilesetOptimization.name} tileset...`);
        }

        const tileCount = this.currentExtractedTiles.length;
        const columnCount = tileCount < this.tilesetMaxColumns ? tileCount : this.tilesetMaxColumns;
        const lineCount = tileCount < this.tilesetMaxColumns ? 1 : Math.ceil(tileCount / columnCount);
        const imageWidth = columnCount * this.tileSize;
        const imageHeight = lineCount * this.tileSize;

        this.currentTilesetOptimization.columns = columnCount;
        this.currentTilesetOptimization.imagewidth = imageWidth;
        this.currentTilesetOptimization.imageheight = imageHeight;
        this.currentTilesetOptimization.tilecount = tileCount;

        const tilesetBuffer = await this.generateNewTilesetBuffer(imageWidth, imageHeight);

        if (this.allowLogs) {
            console.log("Empty image generated");
        }

        const sharpTileset = sharp(tilesetBuffer);

        if (this.allowLogs) {
            console.log("Loading of all tiles who will be optimized...");
        }

        const tileBuffers = await Promise.all(this.currentExtractedTiles);

        if (this.allowLogs) {
            console.log("Tiles loading finished");
            console.log("Tileset optimized image generating...");
        }

        const sharpComposites: sharp.OverlayOptions[] = [];

        let x = 0;
        let y = 0;

        for (const tileBuffer of tileBuffers) {
            if (x === imageWidth) {
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

        this.optimizedTilesets.set(
            this.currentTilesetOptimization,
            await sharpTileset.composite(sharpComposites).toBuffer()
        );

        if (this.allowLogs) {
            console.log("Tileset optimized image generated");
            console.log("The tileset has been rendered");
        }

        this.currentTilesetOptimization = this.generateNextTileset();
        this.currentExtractedTiles = [];
    }
}
