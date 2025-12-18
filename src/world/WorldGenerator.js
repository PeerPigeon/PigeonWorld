/**
 * Procedural World Generator
 * Generates terrain chunks using simplex-like noise algorithm
 */
export class WorldGenerator {
    constructor(seed = 12345) {
        this.seed = seed;
        this.chunkSize = 32; // 32x32 tiles per chunk
        this.tileSize = 32; // pixels per tile
        this.biomes = {
            WATER: { color: '#003366', height: 0.3 }, // Dark navy blue - VERY distinct from sky
            SAND: { color: '#FFD700', height: 0.4 }, // Golden sand
            GRASS: { color: '#228B22', height: 0.6 }, // Forest green grass
            FOREST: { color: '#0B3D0B', height: 0.75 }, // Very dark forest green
            MOUNTAIN: { color: '#696969', height: 0.9 }, // Dim gray mountains
            SNOW: { color: '#F0F0F0', height: 1.0 } // Light gray snow
        };
    }

    /**
     * Simple pseudo-random number generator with seed
     */
    random(x, y) {
        const n = Math.sin(x * 12.9898 + y * 78.233 + this.seed) * 43758.5453123;
        return n - Math.floor(n);
    }

    /**
     * Interpolated noise function
     */
    noise(x, y) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const fx = x - ix;
        const fy = y - iy;

        // Get corner values
        const a = this.random(ix, iy);
        const b = this.random(ix + 1, iy);
        const c = this.random(ix, iy + 1);
        const d = this.random(ix + 1, iy + 1);

        // Smooth interpolation
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);

        // Bilinear interpolation
        const ab = a + sx * (b - a);
        const cd = c + sx * (d - c);
        return ab + sy * (cd - ab);
    }

    /**
     * Layered noise for natural-looking terrain
     */
    fractalNoise(x, y, octaves = 4) {
        let value = 0;
        let amplitude = 1;
        let frequency = 1;
        let maxValue = 0;

        for (let i = 0; i < octaves; i++) {
            value += this.noise(x * frequency * 0.01, y * frequency * 0.01) * amplitude;
            maxValue += amplitude;
            amplitude *= 0.5;
            frequency *= 2;
        }

        return value / maxValue;
    }

    /**
     * Get biome based on height value
     */
    getBiome(height) {
        for (const [name, biome] of Object.entries(this.biomes)) {
            if (height <= biome.height) {
                return { name, ...biome };
            }
        }
        return { name: 'SNOW', ...this.biomes.SNOW };
    }

    /**
     * Generate a chunk at given coordinates (3D version - x and z)
     */
    generateChunk(chunkX, chunkZ) {
        const chunk = {
            x: chunkX,
            z: chunkZ,
            tiles: [],
            entities: []
        };

        const startX = chunkX * this.chunkSize;
        const startZ = chunkZ * this.chunkSize;

        for (let localZ = 0; localZ < this.chunkSize; localZ++) {
            const row = [];
            for (let localX = 0; localX < this.chunkSize; localX++) {
                const worldX = startX + localX;
                const worldZ = startZ + localZ;
                
                // Generate height map
                const height = this.fractalNoise(worldX, worldZ);
                const biome = this.getBiome(height);

                // Add some variation
                const variation = this.random(worldX, worldZ) * 0.2 - 0.1;

                row.push({
                    x: worldX,
                    y: worldZ, // Keep y for compatibility with entity placement
                    height,
                    biome: biome.name,
                    color: biome.color,
                    walkable: biome.name !== 'WATER',
                    variation
                });
            }
            chunk.tiles.push(row);
        }

        // Add some random entities (trees, rocks, etc.)
        this.addEntities(chunk);

        return chunk;
    }

    /**
     * Add entities to a chunk based on biome
     */
    addEntities(chunk) {
        for (let y = 0; y < this.chunkSize; y++) {
            for (let x = 0; x < this.chunkSize; x++) {
                const tile = chunk.tiles[y][x];
                const rand = this.random(tile.x + 1000, tile.y + 1000);

                // Collectible resources (spawn deterministically, sparse)
                // These are intended to be gathered with E.
                if (tile.walkable) {
                    const r1 = this.random(tile.x + 9001, tile.y + 9002);
                    const r2 = this.random(tile.x + 9011, tile.y + 9012);

                    // Wood: mostly in forest/grass
                    if ((tile.biome === 'FOREST' || tile.biome === 'GRASS') && r1 > 0.985) {
                        chunk.entities.push({
                            x: tile.x,
                            y: tile.y,
                            type: 'resource-wood',
                            color: '#C28A3E',
                            size: 0.35
                        });
                    }

                    // Berries: mostly in grass
                    if (tile.biome === 'GRASS' && r2 > 0.988) {
                        chunk.entities.push({
                            x: tile.x,
                            y: tile.y,
                            type: 'resource-berries',
                            color: '#D81B60',
                            size: 0.28
                        });
                    }

                    // Stone: mostly in mountains (and some in sand)
                    if ((tile.biome === 'MOUNTAIN' || tile.biome === 'SAND') && r1 > 0.986) {
                        chunk.entities.push({
                            x: tile.x,
                            y: tile.y,
                            type: 'resource-stone',
                            color: '#90A4AE',
                            size: 0.33
                        });
                    }
                }

                // Trees in forest and grass
                if ((tile.biome === 'FOREST' && rand > 0.7) || 
                    (tile.biome === 'GRASS' && rand > 0.95)) {
                    chunk.entities.push({
                        x: tile.x,
                        y: tile.y,
                        type: 'tree',
                        color: '#1B5E20',
                        size: 0.8
                    });
                }

                // Rocks in mountains
                if (tile.biome === 'MOUNTAIN' && rand > 0.85) {
                    chunk.entities.push({
                        x: tile.x,
                        y: tile.y,
                        type: 'rock',
                        color: '#424242',
                        size: 0.6
                    });
                }

                // Bushes in grass
                if (tile.biome === 'GRASS' && rand > 0.9 && rand < 0.95) {
                    chunk.entities.push({
                        x: tile.x,
                        y: tile.y,
                        type: 'bush',
                        color: '#689F38',
                        size: 0.5
                    });
                }
            }
        }
    }

    /**
     * Get tile at world coordinates
     * Note: This method generates terrain on-the-fly for single tile queries.
     * For rendering, use the chunk cache in GameEngine instead.
     */
    getTileAt(worldX, worldY) {
        const chunkX = Math.floor(worldX / this.chunkSize);
        const chunkY = Math.floor(worldY / this.chunkSize);
        const localX = Math.floor(worldX - chunkX * this.chunkSize);
        const localY = Math.floor(worldY - chunkY * this.chunkSize);

        // Generate height on the fly for collision detection
        const height = this.fractalNoise(worldX, worldY);
        const biome = this.getBiome(height);

        return {
            x: worldX,
            y: worldY,
            height,
            biome: biome.name,
            color: biome.color,
            walkable: biome.name !== 'WATER',
            variation: this.random(worldX, worldY) * 0.2 - 0.1
        };
    }
}
