/**
 * Pass 2 of the optimization: group layers into clusters, each cluster becoming one output tileset
 * holding the union of the tiles used by its member layers.
 *
 * Phaser 4's TilemapGPULayer can only render a layer whose tiles all come from a single tileset, so
 * every output tileset corresponds 1:1 with a cluster of layers. Tiles used by layers living in
 * different clusters are duplicated into each cluster's tileset; the clustering below minimizes this.
 */

export type ClusterInput = {
    /** Position of the layer in the analysis pass output, used for deterministic ordering */
    index: number;
    /** Human-readable name, used in logs */
    name: string;
    /** Unflipped tile GIDs used by the layer (animation closures included) */
    tiles: ReadonlySet<number>;
};

export type Cluster = {
    members: ClusterInput[];
    tiles: Set<number>;
    /**
     * True when a single layer uses more tiles than the capacity of one tileset. Such a cluster is
     * rendered as several tilesets and its layers are not eligible for GPU rendering.
     */
    oversized: boolean;
};

/**
 * Smallest power of 2 greater than or equal to the given tile count: the number of slots of the
 * smallest rectangular power-of-2 texture able to hold that many tiles.
 */
export function slotsFor(tileCount: number): number {
    let slots = 1;
    while (slots < tileCount) {
        slots *= 2;
    }
    return slots;
}

function cost(tileCount: number, fixedCost: number): number {
    return slotsFor(tileCount) + fixedCost;
}

function unionSize(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
    const [small, large] = a.size < b.size ? [a, b] : [b, a];
    let extra = 0;
    for (const tile of small) {
        if (!large.has(tile)) {
            extra++;
        }
    }
    return large.size + extra;
}

/**
 * Greedy agglomerative clustering: start with one cluster per layer and repeatedly merge the pair
 * of clusters saving the most texture slots, as long as the merged cluster fits in `capacity`.
 *
 * Cost of a cluster = power-of-2 padded slot count + `fixedCost` (a per-tileset overhead standing
 * for the extra HTTP request / texture bind, which pushes small disjoint layers to share a
 * tileset). Since padding never grows when merging, clusters merge until the capacity is reached,
 * high-overlap pairs first — which is what minimizes tile duplication across tilesets.
 *
 * Layers with no tiles are skipped, layers bigger than `capacity` get their own cluster flagged
 * `oversized`. Output is deterministic: clusters and their members are ordered by layer index.
 */
export function clusterLayers(inputs: ClusterInput[], capacity: number, fixedCost = 64): Cluster[] {
    const clusters: Cluster[] = [];

    for (const input of inputs) {
        if (input.tiles.size === 0) {
            continue;
        }

        clusters.push({
            members: [input],
            tiles: new Set(input.tiles),
            oversized: input.tiles.size > capacity,
        });
    }

    for (;;) {
        let best: { i: number; j: number; savings: number } | undefined;

        for (let i = 0; i < clusters.length; i++) {
            if (clusters[i].oversized) {
                continue;
            }

            for (let j = i + 1; j < clusters.length; j++) {
                if (clusters[j].oversized) {
                    continue;
                }

                const merged = unionSize(clusters[i].tiles, clusters[j].tiles);

                if (merged > capacity) {
                    continue;
                }

                const savings =
                    cost(clusters[i].tiles.size, fixedCost) +
                    cost(clusters[j].tiles.size, fixedCost) -
                    cost(merged, fixedCost);

                // Strict comparison: on equal savings the first (lowest-index) pair wins, keeping the
                // result deterministic.
                if (savings > 0 && (!best || savings > best.savings)) {
                    best = { i, j, savings };
                }
            }
        }

        if (!best) {
            break;
        }

        const absorbed = clusters.splice(best.j, 1)[0];
        const target = clusters[best.i];
        target.members.push(...absorbed.members);

        for (const tile of absorbed.tiles) {
            target.tiles.add(tile);
        }
    }

    for (const cluster of clusters) {
        cluster.members.sort((a, b) => a.index - b.index);
    }

    clusters.sort((a, b) => a.members[0].index - b.members[0].index);

    return clusters;
}
