import { z } from "zod";

export enum LogLevel {
    NONE = 0,
    NORMAL = 1,
    VERBOSE = 2,
}

const isLogLevel = z.nativeEnum(LogLevel);

const isPowerOfTwo = (value: number) => Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;

/**
 * Maximum size (in pixels) of an output tileset texture. Must be a power of 2 so the generated
 * textures are GPU-friendly. Defaults to 4096.
 */
const isTilesetMaxSize = z
    .number()
    .gte(32)
    .refine(isPowerOfTwo, { message: "Tileset size must be a power of 2" })
    .optional();

const isOptimizeBufferOptions = z.object({
    tile: z
        .object({
            size: z.number().positive().optional(),
        })
        .optional(),
    logs: isLogLevel.optional(),
    output: z
        .object({
            tileset: z
                .object({
                    prefix: z.string().optional(),
                    suffix: z.string().optional(),
                    size: isTilesetMaxSize,
                })
                .optional(),
        })
        .optional(),
});

export type OptimizeBufferOptions = z.infer<typeof isOptimizeBufferOptions>;

const isOptimizeOptions = isOptimizeBufferOptions.extend({
    output: z
        .object({
            map: z
                .object({
                    name: z.string().optional(),
                })
                .optional(),
            path: z.string().optional(),
            tileset: z
                .object({
                    prefix: z.string().optional(),
                    suffix: z.string().optional(),
                    size: isTilesetMaxSize,
                    compress: z
                        .object({
                            quality: z.tuple([z.number().gte(0).lte(1), z.number().gte(0).lte(1)]).optional(),
                        })
                        .optional(),
                })
                .optional(),
        })
        .optional(),
});

export type OptimizeOptions = z.infer<typeof isOptimizeOptions>;
