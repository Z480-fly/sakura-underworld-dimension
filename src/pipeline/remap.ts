/**
 * Falling-block remap.
 *
 * A structure is placed block by block by the game, so a gravity block placed
 * that way starts falling the moment it exists - the terrain that should hold it
 * up has not been written yet. `minecraft:gravel` is 263 268 of the source
 * world's 4 029 593 blocks (6.5%), spread right through the island, so the
 * Underworld used to arrive with its gravel already dropped.
 *
 * The replacement is black glass: `minecraft:black_stained_glass` with a share
 * of `minecraft:tinted_glass`. Both belong to the palette the world is already
 * built from (obsidian, deepslate, blackstone, basalt) and, like the gravel they
 * replace, they read as a varied dark filler rather than a single flat block.
 *
 * The choice is made from the block's own coordinates, so the mix is stable:
 * the same world always produces the same tiles.
 */
import type { BlockStateEntry } from "../mcworld/subchunk.ts";

export interface BlockReplacement {
  readonly name: string;
  /** Relative share of the replaced blocks. */
  readonly weight: number;
}

/** What every falling block in the source world becomes. */
const BLACK_GLASS: readonly BlockReplacement[] = [
  { name: "minecraft:black_stained_glass", weight: 3 },
  { name: "minecraft:tinted_glass", weight: 1 },
];

const CONCRETE_COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

/**
 * Falling blocks and what they are written as instead. The source world only
 * uses gravel; the rest are listed so a later re-extraction of a changed world
 * cannot smuggle a block that drops out of the tiles back in.
 */
export const GRAVITY_BLOCK_REPLACEMENTS: Readonly<Record<string, readonly BlockReplacement[]>> = Object.freeze({
  "minecraft:gravel": BLACK_GLASS,
  "minecraft:sand": BLACK_GLASS,
  "minecraft:red_sand": BLACK_GLASS,
  ...Object.fromEntries(CONCRETE_COLORS.map((color) => [`minecraft:${color}_concrete_powder`, BLACK_GLASS])),
});

/** Every block this remap takes out of the package. */
export const GRAVITY_BLOCKS: readonly string[] = Object.freeze(Object.keys(GRAVITY_BLOCK_REPLACEMENTS));

/** The block a falling block is written as at this position, if it is remapped. */
export function replacementFor(name: string, x: number, y: number, z: number): string | undefined {
  const options = GRAVITY_BLOCK_REPLACEMENTS[name];
  if (!options) return undefined;
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let pick = positionHash(x, y, z) % total;
  for (const option of options) {
    if (pick < option.weight) return option.name;
    pick -= option.weight;
  }
  return options[options.length - 1]!.name;
}

/** Applies {@link replacementFor} to a palette entry, keeping its data version. */
export function remapEntry(entry: BlockStateEntry, x: number, y: number, z: number): BlockStateEntry {
  const name = replacementFor(entry.name, x, y, z);
  if (name === undefined) return entry;
  // The replacement's own state schema applies, never the source block's.
  return { name, states: new Map(), version: entry.version };
}

/** The names a falling block is replaced by, for narration. */
export function replacementNames(name: string): string[] {
  return (GRAVITY_BLOCK_REPLACEMENTS[name] ?? []).map((option) => option.name);
}

function positionHash(x: number, y: number, z: number): number {
  let hash = 2166136261;
  for (const value of [x, y, z]) hash = Math.imul(hash ^ (value | 0), 16777619);
  return hash >>> 0;
}
