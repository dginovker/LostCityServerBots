import fs from 'fs';
import LocType from '../../src/cache/config/LocType.js';
import World from '../../src/engine/World.js';
import type Loc from '../../src/engine/entity/Loc.js';

interface DoorEntry {
    x: number;
    z: number;
    level: number;
    locType: number; // LocType id
}

// Wall-type loc shapes that represent doors/gates (from rsmod-pathfinder LocShape enum).
// Shapes 0-3 and 9 are wall types; shapes 10+ are centrepieces (chests, barrels, etc.)
// which should NOT be treated as doors even if they have op[0]='Open'.
const WALL_SHAPES = new Set([0, 1, 2, 3, 9]); // WALL_STRAIGHT, WALL_DIAGONAL_CORNER, WALL_L, WALL_SQUARE_CORNER, WALL_DIAGONAL

/**
 * Pre-computed registry of all openable doors/gates in the game world.
 * Lazily initialized on first use by scanning all loaded map zones for locs
 * where LocType.op[0] === 'Open' AND the loc shape is a wall type.
 *
 * Provides O(1) tile lookup and efficient radius search via spatial index.
 */
class DoorRegistry {
    /** Spatial index: key = "x_z_level", value = array of door entries on that tile */
    private doors: Map<string, DoorEntry[]> | null = null;

    /** All door entries, for radius search */
    private allDoors: DoorEntry[] | null = null;

    private tileKey(x: number, z: number, level: number): string {
        return `${x}_${z}_${level}`;
    }

    /**
     * Lazily scan all loaded zones for openable locs and populate the registry.
     */
    private init(): void {
        if (this.doors !== null) return;

        this.doors = new Map();
        this.allDoors = [];

        // Scan map files to find all loaded mapsquare coordinates.
        // Map files are named m{mx}_{mz} in the maps directory.
        // Uses the same path as GameMap.init() — 'data/pack/server/maps/' relative to CWD.
        const mapsDir = 'data/pack/server/maps';
        if (!fs.existsSync(mapsDir)) return;

        const mapFiles = fs.readdirSync(mapsDir).filter(f => f[0] === 'm');

        for (const mapFile of mapFiles) {
            const parts = mapFile.substring(1).split('_').map(Number);
            const mx = parts[0]!;
            const mz = parts[1]!;
            const mapsquareX = mx << 6;
            const mapsquareZ = mz << 6;

            // Each mapsquare is 64x64 tiles, divided into 8x8 zones = 8x8 zones per mapsquare
            for (let level = 0; level < 4; level++) {
                for (let zoneOffX = 0; zoneOffX < 8; zoneOffX++) {
                    for (let zoneOffZ = 0; zoneOffZ < 8; zoneOffZ++) {
                        const zoneX = mapsquareX + zoneOffX * 8;
                        const zoneZ = mapsquareZ + zoneOffZ * 8;

                        let zone;
                        try {
                            zone = World.gameMap.getZone(zoneX, zoneZ, level);
                        } catch {
                            continue;
                        }

                        for (const loc of zone.getAllLocsSafe()) {
                            // Only consider wall-shaped locs (doors/gates), not centrepieces (chests/barrels)
                            if (!WALL_SHAPES.has(loc.shape)) {
                                continue;
                            }
                            const locType = LocType.get(loc.type);
                            if (locType.op?.[0]?.toLowerCase() !== 'open') {
                                continue;
                            }

                            const entry: DoorEntry = {
                                x: loc.x,
                                z: loc.z,
                                level,
                                locType: loc.type
                            };

                            const key = this.tileKey(loc.x, loc.z, level);
                            const existing = this.doors.get(key);
                            if (existing) {
                                existing.push(entry);
                            } else {
                                this.doors.set(key, [entry]);
                            }
                            this.allDoors.push(entry);
                        }
                    }
                }
            }
        }
    }

    /**
     * Quick check if a tile has an openable door/gate.
     */
    isDoorAt(x: number, z: number, level: number): boolean {
        this.init();
        return this.doors!.has(this.tileKey(x, z, level));
    }

    /**
     * Find all openable door/gate locs within `radius` Chebyshev distance of (x, z)
     * on the given level. Returns actual Loc objects from the live game zones
     * (so they can be interacted with), sorted by distance.
     *
     * Only returns locs that are currently active (still closed / not yet opened).
     */
    findDoorsNear(x: number, z: number, level: number, radius: number): Loc[] {
        this.init();

        // Collect candidate tile keys within the radius
        const candidates: DoorEntry[] = [];
        for (const entry of this.allDoors!) {
            if (entry.level !== level) continue;
            const dist = Math.max(Math.abs(entry.x - x), Math.abs(entry.z - z));
            if (dist <= radius) {
                candidates.push(entry);
            }
        }

        // Resolve to live Loc objects from the game zones
        const results: { loc: Loc; dist: number }[] = [];
        for (const entry of candidates) {
            const zone = World.gameMap.getZone(entry.x, entry.z, entry.level);
            for (const loc of zone.getAllLocsSafe()) {
                if (loc.x !== entry.x || loc.z !== entry.z) continue;
                if (!WALL_SHAPES.has(loc.shape)) continue;
                const locType = LocType.get(loc.type);
                if (locType.op?.[0]?.toLowerCase() !== 'open') continue;
                const dist = Math.max(Math.abs(loc.x - x), Math.abs(loc.z - z));
                results.push({ loc, dist });
            }
        }

        results.sort((a, b) => a.dist - b.dist);
        return results.map(r => r.loc);
    }
}

/** Singleton door registry instance */
export const doorRegistry = new DoorRegistry();
