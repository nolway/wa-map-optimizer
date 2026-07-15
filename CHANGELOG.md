# Changelog

## [2.0.0](https://github.com/nolway/wa-map-optimizer/compare/v1.4.8...v2.0.0) (2026-07-15)


### ⚠ BREAKING CHANGES

* output.tileset.size now means the maximum texture size (must be a power of 2, default 4096) instead of the fixed 512px chunk size, and output tilesets are laid out per layer cluster rather than as sequential fixed-size chunks.

### Features

* guarantee one tileset per layer for Phaser 4 TilemapGPULayer ([#18](https://github.com/nolway/wa-map-optimizer/issues/18)) ([fb01ec0](https://github.com/nolway/wa-map-optimizer/commit/fb01ec0f557d54829c5dfc7a7fdfe5bd6b4cbd5d))
* use OIDC npm connection ([3b101e0](https://github.com/nolway/wa-map-optimizer/commit/3b101e0614b9ecf96c5277c801a49c285c4e9f37))


### Performance Improvements

* speed up tileset rendering ~19x (raw pixel pipeline) ([#19](https://github.com/nolway/wa-map-optimizer/issues/19)) ([8272ee0](https://github.com/nolway/wa-map-optimizer/commit/8272ee0f6501caec715cd597b2997fc6c1d0aaec))

## [1.4.8](https://github.com/Nolway/wa-map-optimizer/compare/v1.4.7...v1.4.8) (2024-06-19)


### Bug Fixes

* Fixing animation optimization issue ([74919b5](https://github.com/Nolway/wa-map-optimizer/commit/74919b5a0b583a4ddec41ee5cf0bc533a81591c3))

## [1.4.7](https://github.com/Nolway/wa-map-optimizer/compare/v1.4.6...v1.4.7) (2023-12-13)


### Bug Fixes

* Fixing missing await in animation generation spawning 2 tilesets ([ae57ab4](https://github.com/Nolway/wa-map-optimizer/commit/ae57ab4a4702fe771f44818dcee06d977ab80113))
* Making it easy to run example with Node 20 ([38a98e2](https://github.com/Nolway/wa-map-optimizer/commit/38a98e2804f0cfa43568e886de5cb97ccb7cec93))

## [1.4.6](https://github.com/Nolway/wa-map-optimizer/compare/v1.4.3...v1.4.6) (2023-11-24)


### Bug Fixes

* Reverting optimization ([0f4ad5c](https://github.com/Nolway/wa-map-optimizer/commit/0f4ad5c3a17534e934def4f99f6ac37f7c861b2a))


### Miscellaneous Chores

* release 1.4.6 ([7744227](https://github.com/Nolway/wa-map-optimizer/commit/7744227c39e7bd6080450e11a4b436ae1d0251b7))
