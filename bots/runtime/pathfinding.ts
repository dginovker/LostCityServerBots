import { findPath, findPathToLoc } from '../../src/engine/GameMap.ts';

/**
 * Run a single rsmod pathfind from (srcX,srcZ) to (destX,destZ).
 * Returns a Uint32Array of packed waypoint coords (in rsmod's reversed order).
 * The engine's findPath has a search radius of 25 tiles — if the destination
 * is further, the result will be a partial path toward it.
 */
export function findPathSegment(level: number, srcX: number, srcZ: number, destX: number, destZ: number): Uint32Array {
    return findPath(level, srcX, srcZ, destX, destZ);
}

/**
 * Run rsmod pathfind from (srcX,srcZ) to a Loc at (destX,destZ) with given dimensions/shape.
 * This is the loc-aware variant that accounts for the loc's width, length, angle, and shape
 * when determining the reach/approach tile.
 */
export function findPathToLocSegment(
    level: number, srcX: number, srcZ: number,
    destX: number, destZ: number, srcSize: number,
    destWidth: number, destHeight: number, angle: number, shape: number,
    blockAccessFlags: number
): Uint32Array {
    return findPathToLoc(level, srcX, srcZ, destX, destZ, srcSize, destWidth, destHeight, angle, shape, blockAccessFlags);
}
