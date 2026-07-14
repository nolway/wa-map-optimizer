import { describe, expect, it } from "vitest";
import { ClusterInput, clusterLayers, slotsFor } from "../src/Clustering.js";
import { applyFlipBits, stripFlipBits } from "../src/LayerAnalysis.js";

function input(index: number, tiles: number[]): ClusterInput {
    return { index, name: `layer-${index}`, tiles: new Set(tiles) };
}

function range(start: number, count: number): number[] {
    return Array.from({ length: count }, (_, i) => start + i);
}

describe("slotsFor", () => {
    it("returns the smallest power of 2 above the tile count", () => {
        expect(slotsFor(0)).toBe(1);
        expect(slotsFor(1)).toBe(1);
        expect(slotsFor(2)).toBe(2);
        expect(slotsFor(3)).toBe(4);
        expect(slotsFor(1024)).toBe(1024);
        expect(slotsFor(1025)).toBe(2048);
    });
});

describe("clusterLayers", () => {
    it("puts a single layer in a single cluster", () => {
        const clusters = clusterLayers([input(0, [1, 2, 3])], 256);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].tiles).toEqual(new Set([1, 2, 3]));
        expect(clusters[0].oversized).toBe(false);
    });

    it("skips layers without tiles", () => {
        const clusters = clusterLayers([input(0, []), input(1, [1])], 256);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].members.map((member) => member.index)).toEqual([1]);
    });

    it("merges identical layers into one cluster", () => {
        const clusters = clusterLayers([input(0, [1, 2]), input(1, [1, 2])], 256);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].tiles).toEqual(new Set([1, 2]));
    });

    it("merges small disjoint layers to amortize the per-tileset cost", () => {
        const clusters = clusterLayers([input(0, [1, 2]), input(1, [10, 11])], 256);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].tiles).toEqual(new Set([1, 2, 10, 11]));
    });

    it("does not merge beyond the capacity", () => {
        const clusters = clusterLayers([input(0, range(0, 6)), input(1, range(100, 6))], 8);

        expect(clusters).toHaveLength(2);
    });

    it("prefers merging overlapping layers when the capacity is tight", () => {
        // A and B share 5 tiles, C is disjoint. Capacity 8 only allows one merge: A+B.
        const clusters = clusterLayers(
            [input(0, range(0, 5)), input(1, [...range(0, 5), 6]), input(2, range(100, 5))],
            8
        );

        expect(clusters).toHaveLength(2);
        expect(clusters[0].members.map((member) => member.index)).toEqual([0, 1]);
        expect(clusters[0].tiles.size).toBe(6);
        expect(clusters[1].members.map((member) => member.index)).toEqual([2]);
    });

    it("flags a layer bigger than the capacity as oversized and never merges it", () => {
        const clusters = clusterLayers([input(0, range(0, 20)), input(1, [1, 2])], 16);

        expect(clusters).toHaveLength(2);
        expect(clusters[0].oversized).toBe(true);
        expect(clusters[0].members.map((member) => member.index)).toEqual([0]);
        expect(clusters[1].oversized).toBe(false);
    });

    it("merges everything into one tileset when the whole map fits", () => {
        const layers = [
            input(0, range(0, 100)),
            input(1, range(50, 100)),
            input(2, range(200, 30)),
            input(3, [5, 6, 7]),
        ];

        const clusters = clusterLayers(layers, 16384);

        expect(clusters).toHaveLength(1);
        expect(clusters[0].members.map((member) => member.index)).toEqual([0, 1, 2, 3]);
    });

    it("is deterministic: same input twice gives the same output", () => {
        const layers = () => [
            input(0, range(0, 60)),
            input(1, range(30, 60)),
            input(2, range(200, 60)),
            input(3, range(230, 60)),
        ];

        const first = clusterLayers(layers(), 128);
        const second = clusterLayers(layers(), 128);

        expect(second).toEqual(first);
    });
});

describe("flip bits", () => {
    it("round-trips flipped gids, including bit 31", () => {
        const flippedGid = 2147483648 + 1073741824 + 42; // horizontal + vertical flips on tile 42

        const { gid, flipBits } = stripFlipBits(flippedGid);

        expect(gid).toBe(42);
        expect(applyFlipBits(7, flipBits)).toBe(2147483648 + 1073741824 + 7);
    });

    it("leaves unflipped gids untouched", () => {
        const { gid, flipBits } = stripFlipBits(1500);

        expect(gid).toBe(1500);
        expect(flipBits).toBe(0);
        expect(applyFlipBits(gid, flipBits)).toBe(1500);
    });
});
