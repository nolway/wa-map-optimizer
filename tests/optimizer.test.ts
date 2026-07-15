import { ITiledMap, ITiledMapEmbeddedTileset, ITiledMapLayer } from "@workadventure/tiled-map-type-guard";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { slotsFor } from "../src/Clustering.js";
import { Optimizer } from "../src/Optimizer.js";

const TILE = 8;

const tmpDirs: string[] = [];

afterAll(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * A single blank source tileset holding `columns * rows` tiles, plus its Sharp buffer. Pixels are
 * irrelevant here — the tests only assert on the emitted GID bookkeeping, not on rendered images.
 */
function sourceTileset(columns: number, rows: number): { tileset: ITiledMapEmbeddedTileset; buffer: sharp.Sharp } {
    const width = columns * TILE;
    const height = rows * TILE;
    const raw = Buffer.alloc(width * height * 4, 0);
    const buffer = sharp(raw, { raw: { width, height, channels: 4 } }).png();

    const tileset = {
        columns,
        firstgid: 1,
        image: "source.png",
        imageheight: height,
        imagewidth: width,
        margin: 0,
        name: "source",
        spacing: 0,
        tilecount: columns * rows,
        tileheight: TILE,
        tilewidth: TILE,
    } as ITiledMapEmbeddedTileset;

    return { tileset, buffer };
}

type Rgba = [number, number, number, number];

/**
 * A source tileset whose tiles are each filled with a distinct solid RGBA colour, laid out
 * left-to-right, top-to-bottom. Unlike `sourceTileset`, pixels matter here: the rendering test
 * decodes the optimized output and asserts each tile landed at the right position with its colour
 * and alpha intact.
 */
function coloredSource(colors: Rgba[], columns: number): { tileset: ITiledMapEmbeddedTileset; buffer: sharp.Sharp } {
    const rows = Math.ceil(colors.length / columns);
    const width = columns * TILE;
    const height = rows * TILE;
    const raw = Buffer.alloc(width * height * 4, 0);

    colors.forEach((color, i) => {
        const originX = (i % columns) * TILE;
        const originY = Math.floor(i / columns) * TILE;
        for (let py = 0; py < TILE; py++) {
            for (let px = 0; px < TILE; px++) {
                const offset = ((originY + py) * width + (originX + px)) * 4;
                raw[offset] = color[0];
                raw[offset + 1] = color[1];
                raw[offset + 2] = color[2];
                raw[offset + 3] = color[3];
            }
        }
    });

    const buffer = sharp(raw, { raw: { width, height, channels: 4 } }).png();

    const tileset = {
        columns,
        firstgid: 1,
        image: "source.png",
        imageheight: height,
        imagewidth: width,
        margin: 0,
        name: "source",
        spacing: 0,
        tilecount: colors.length,
        tileheight: TILE,
        tilewidth: TILE,
    } as ITiledMapEmbeddedTileset;

    return { tileset, buffer };
}

function tileLayer(name: string, gids: number[]): ITiledMapLayer {
    return {
        type: "tilelayer",
        name,
        data: gids,
        width: gids.length,
        height: 1,
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
    } as unknown as ITiledMapLayer;
}

/**
 * Runs the real optimizer on a synthetic map made of the given layers (all referencing one blank
 * source tileset big enough to hold every gid) and returns the emitted tilesets.
 */
async function optimize(layers: ITiledMapLayer[], tilesetSize: number): Promise<ITiledMapEmbeddedTileset[]> {
    const maxGid = Math.max(...layers.flatMap((layer) => layer.data as number[]));
    const columns = 16;
    const rows = Math.ceil(maxGid / columns);
    const source = sourceTileset(columns, rows);

    const map = { layers, tilesets: [source.tileset] } as unknown as ITiledMap;
    const buffers = new Map<ITiledMapEmbeddedTileset, sharp.Sharp>([[source.tileset, source.buffer]]);

    const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), "wa-opt-"));
    tmpDirs.push(outputPath);

    const optimizer = new Optimizer(
        map,
        buffers,
        { tile: { size: TILE }, logs: 0, output: { tileset: { size: tilesetSize } } },
        outputPath
    );

    const result = await optimizer.optimize();
    return result.tilesets as ITiledMapEmbeddedTileset[];
}

function range(start: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => start + i);
}

function capacity(tileset: ITiledMapEmbeddedTileset): number {
    return (tileset.columns ?? 0) * ((tileset.imageheight ?? 0) / TILE);
}

/**
 * The core invariant: every tileset reserves its full image-grid capacity as GIDs, and no two
 * tilesets' [firstgid, firstgid + tilecount) ranges intersect. Phaser derives a tileset's tile
 * count from the image dimensions and ignores `tilecount`, so a violation of this silently drops
 * tiles on classic TilemapLayer rendering.
 */
function expectNoOverlappingGidRanges(tilesets: ITiledMapEmbeddedTileset[]): void {
    for (const tileset of tilesets) {
        expect(tileset.tilecount).toBe(capacity(tileset));
    }

    const sorted = [...tilesets].sort((a, b) => (a.firstgid ?? 0) - (b.firstgid ?? 0));
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        expect(curr.firstgid ?? 0).toBeGreaterThanOrEqual((prev.firstgid ?? 0) + (prev.tilecount ?? 0));
    }
}

describe("Optimizer GID ranges", () => {
    it("reserves the full image-grid capacity as tilecount, not the used tile count", async () => {
        // 40 tiles -> smallest power-of-2 grid is 64 slots (8x8). The tileset must claim all 64.
        const tilesets = await optimize([tileLayer("floor", range(1, 40))], 64);

        expect(tilesets).toHaveLength(1);
        expect(tilesets[0].firstgid).toBe(1);
        expect(tilesets[0].tilecount).toBe(slotsFor(40));
        expect(tilesets[0].tilecount).toBe(capacity(tilesets[0]));
    });

    it("keeps consecutive tilesets' GID ranges from overlapping when a chunk is not power-of-2", async () => {
        // Two disjoint 40-tile layers (union 80 > capacity 64) render as two separate tilesets.
        // Each holds 40 tiles in a 64-slot image; advancing firstgid by 40 instead of 64 would make
        // the second tileset's range overlap the first's padded tail — the original bug.
        const tilesets = await optimize([tileLayer("floor", range(1, 40)), tileLayer("furniture", range(100, 40))], 64);

        expect(tilesets).toHaveLength(2);
        const sorted = [...tilesets].sort((a, b) => (a.firstgid ?? 0) - (b.firstgid ?? 0));
        expect(sorted[0].firstgid).toBe(1);
        expect(sorted[1].firstgid).toBe(1 + slotsFor(40)); // 65, not 41
        expectNoOverlappingGidRanges(tilesets);
    });

    it("splits an oversized layer into non-overlapping tilesets alongside another layer", async () => {
        // 150 tiles > capacity 64 -> the layer is split into 64 + 64 + 22 tiles. The trailing 22-tile
        // chunk pads to a 32-slot image; a second disjoint layer follows it. This mirrors the
        // wa-headquarters GroundWorld/AboveWorld case where furniture went missing.
        const tilesets = await optimize([tileLayer("world", range(1, 150)), tileLayer("signs", range(200, 5))], 64);

        expect(tilesets.length).toBeGreaterThanOrEqual(3);
        expectNoOverlappingGidRanges(tilesets);

        // Ranges are contiguous: each firstgid stride equals the previous tileset's capacity.
        const sorted = [...tilesets].sort((a, b) => (a.firstgid ?? 0) - (b.firstgid ?? 0));
        for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i].firstgid).toBe((sorted[i - 1].firstgid ?? 0) + capacity(sorted[i - 1]));
        }
    });
});

describe("Optimizer pixel rendering", () => {
    it("places each tile's pixels and alpha at the correct position in the output image", async () => {
        // Four distinct tiles. The last is semi-transparent: the raw-copy pipeline must preserve its
        // colour and alpha exactly (no premultiplication), and drop it at the right cell.
        const colors: Rgba[] = [
            [255, 0, 0, 255], // gid 1
            [0, 255, 0, 255], // gid 2
            [0, 0, 255, 255], // gid 3
            [10, 20, 30, 128], // gid 4 (semi-transparent)
        ];
        const source = coloredSource(colors, 2);

        const map = {
            layers: [tileLayer("floor", [1, 2, 3, 4])],
            tilesets: [source.tileset],
        } as unknown as ITiledMap;
        const buffers = new Map<ITiledMapEmbeddedTileset, sharp.Sharp>([[source.tileset, source.buffer]]);

        const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), "wa-opt-"));
        tmpDirs.push(outputPath);

        const optimizer = new Optimizer(
            map,
            buffers,
            { tile: { size: TILE }, logs: 0, output: { tileset: { size: 64 } } },
            outputPath
        );
        const result = await optimizer.optimize();

        expect(result.tilesets).toHaveLength(1);
        const image = result.tilesets[0] as ITiledMapEmbeddedTileset;
        const outColumns = image.columns ?? 0;

        const { data, info } = await sharp(path.join(outputPath, image.image as string))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        // Tiles are emitted in sorted-gid order, so local id i corresponds to gid i+1 (colors[i]) and
        // sits at grid cell (i % columns, i / columns). Sample the centre of each cell.
        colors.forEach((color, i) => {
            const px = (i % outColumns) * TILE + Math.floor(TILE / 2);
            const py = Math.floor(i / outColumns) * TILE + Math.floor(TILE / 2);
            const offset = (py * info.width + px) * 4;
            expect([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]).toEqual(color);
        });
    });
});
