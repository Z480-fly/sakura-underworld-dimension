/**
 * Works out which subchunk ordering a source world actually uses.
 *
 * Reading `ids[p]` with the wrong axis permutation does not produce noise - it
 * produces a *transposed* world: vertical columns become horizontal bars inside
 * every 16x16x16 subchunk. The giveaway is terrain smoothness. Decoded
 * correctly, neighbouring columns differ by a block or two; decoded with the
 * wrong permutation, neighbouring heights jump all over the 0..127 range, so
 * the mean slope of the height map explodes.
 *
 * The probe therefore measures both readings over a sample of the realm and
 * reports the mean absolute height difference between adjacent columns.
 */
import type { BlockOrder } from "./layout.ts";
import { BLOCK_ORDERS, packedIndex } from "./layout.ts";
import type { UnderworldSource } from "./source.ts";

export interface OrderScore {
  order: BlockOrder;
  /** Mean |height difference| between horizontally adjacent columns. */
  roughness: number;
  landColumns: number;
  solidBlocks: number;
  comparedPairs: number;
}

/** Topmost non-air block of a column, or undefined for a void column. */
export function heightAt(source: UnderworldSource, order: BlockOrder, x: number, z: number): number | undefined {
  const cx = x >> 4;
  const cz = z >> 4;
  const lx = x & 15;
  const lz = z & 15;
  for (let subY = 7; subY >= 0; subY--) {
    const sub = source.subChunkAt(cx, cz, subY);
    if (!sub) continue;
    for (let ly = 15; ly >= 0; ly--) {
      const index = sub.ids[packedIndex(order, lx, ly, lz)];
      const entry = index === undefined ? undefined : sub.palette[index];
      if (entry && entry.name !== "minecraft:air") return subY * 16 + ly;
    }
  }
  return undefined;
}

export function scoreOrder(source: UnderworldSource, order: BlockOrder): OrderScore {
  const centerCx = Math.floor((source.bounds.minChunkX + source.bounds.maxChunkX) / 2);
  const centerCz = Math.floor((source.bounds.minChunkZ + source.bounds.maxChunkZ) / 2);
  const half = 4;

  let solidBlocks = 0;
  for (let cx = centerCx - half; cx < centerCx + half; cx++) {
    for (let cz = centerCz - half; cz < centerCz + half; cz++) {
      for (let subY = 0; subY <= 7; subY++) {
        const sub = source.subChunkAt(cx, cz, subY);
        if (!sub) continue;
        for (let i = 0; i < sub.ids.length; i++) {
          const entry = sub.palette[sub.ids[i]!];
          if (entry && entry.name !== "minecraft:air") solidBlocks++;
        }
      }
    }
  }

  const heights = new Map<string, number>();
  let landColumns = 0;
  for (let cx = centerCx - half; cx < centerCx + half; cx++) {
    for (let cz = centerCz - half; cz < centerCz + half; cz++) {
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const x = cx * 16 + lx;
          const z = cz * 16 + lz;
          const height = heightAt(source, order, x, z);
          if (height === undefined) continue;
          landColumns++;
          heights.set(`${x},${z}`, height);
        }
      }
    }
  }

  let total = 0;
  let comparedPairs = 0;
  for (const [key, height] of heights) {
    const [x, z] = key.split(",").map(Number) as [number, number];
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const neighbour = heights.get(`${x + dx},${z + dz}`);
      if (neighbour === undefined) continue;
      total += Math.abs(neighbour - height);
      comparedPairs++;
    }
  }

  return {
    order,
    roughness: comparedPairs === 0 ? Number.POSITIVE_INFINITY : total / comparedPairs,
    landColumns,
    solidBlocks,
    comparedPairs,
  };
}

export interface OrderDetection {
  best: BlockOrder;
  scores: OrderScore[];
  margin: number;
}

export function detectOrder(source: UnderworldSource): OrderDetection {
  const scores = BLOCK_ORDERS.map((order) => scoreOrder(source, order)).sort((a, b) => a.roughness - b.roughness);
  const best = scores[0]!;
  const runnerUp = scores[1] ?? best;
  return {
    best: best.order,
    scores,
    margin: runnerUp.roughness === 0 ? Infinity : best.roughness / runnerUp.roughness,
  };
}
