/**
 * Subchunk block orderings.
 *
 * Bedrock stores the block at `(x, y, z)` inside a 16x16x16 subchunk at packed
 * position `(x << 8) | (z << 4) | y` (y varies fastest). That is what every
 * production Bedrock implementation uses and what the documentation describes
 * as "XZY order".
 *
 * The generator behind `unstable-underworld-bedrock` builds its in-memory
 * indices with `x + (z << 4) + (y << 8)` and copies them straight into the
 * payload, which reverses the axes inside every subchunk. Its own source
 * comment claims the Bedrock order, so the code and the comment disagree.
 *
 * Which one the shipped `.mcworld` actually is cannot be settled by reading the
 * file - it has to be measured. `src/pipeline/probe.ts` decodes the realm both
 * ways and compares how smooth the resulting terrain is; the extraction then
 * uses the winner, so the dimension always reproduces the map the generator
 * meant to build rather than a transposed accident.
 */
export type BlockOrder = "bedrock" | "generator";

export const BLOCK_ORDERS: readonly BlockOrder[] = ["bedrock", "generator"];

export function packedIndex(order: BlockOrder, x: number, y: number, z: number): number {
  return order === "bedrock" ? (x << 8) | (z << 4) | y : x + (z << 4) + (y << 8);
}

export function describeOrder(order: BlockOrder): string {
  return order === "bedrock"
    ? "Bedrock (x << 8 | z << 4 | y)"
    : "generator (x + z<<4 + y<<8)";
}
