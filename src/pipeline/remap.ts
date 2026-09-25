/**
 * Falling-block remap.
 *
 * Gravity blocks - `minecraft:gravel`, the sands and concrete powder - do not
 * stay where they are put. The game gives them a falling-block component, and
 * every tick an unsupported one turns into a falling block entity and drops
 * until something holds it up.
 *
 * That is fatal for a structure tile. A `.mcstructure` is written into the
 * world block by block, so a gravity block is placed, finds nothing under it
 * yet (the terrain that supports it is still being written), and drops out of
 * the tile before the rest of the tile exists. The result is the Underworld
 * arriving with its gravel already fallen and holes where it used to be:
 * `minecraft:gravel` alone is 238 334 of the source world's 4 029 593 blocks
 * (5.9%), spread right through the island.
 *
 * The fix is to never put a gravity block into a tile at all. Every one of them
 * is written as `minecraft:green_stained_glass`, which has no falling component,
 * so it stays exactly where the tile puts it and the terrain loads in whole.
 * Stained glass is also what the user asked for, and green reads clearly against
 * the obsidian / deepslate / blackstone palette the rest of the world is built
 * from.
 *
 * The table is a list of weighted options so a mix is a one-line change, but it
 * currently holds a single block: every falling block becomes green stained
 * glass.
 */
import type { BlockStateEntry } from "../mcworld/subchunk.ts";

export interface BlockReplacement {
  readonly name: string;
  /** Relative share of the replaced blocks. */
  readonly weight: number;
}

/** The one block every falling block in the source world becomes. */
export const GREEN_STAINED_GLASS = "minecraft:green_stained_glass";

/** What every falling block in the source world becomes. */
const GREEN_GLASS: readonly BlockReplacement[] = [{ name: GREEN_STAINED_GLASS, weight: 1 }];

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
  "minecraft:gravel": GREEN_GLASS,
  "minecraft:sand": GREEN_GLASS,
  "minecraft:red_sand": GREEN_GLASS,
  ...Object.fromEntries(CONCRETE_COLORS.map((color) => [`minecraft:${color}_concrete_powder`, GREEN_GLASS])),
});

/** Every block this remap takes out of the package. */
export const GRAVITY_BLOCKS: readonly string[] = Object.freeze(Object.keys(GRAVITY_BLOCK_REPLACEMENTS));

/** The block a falling block is written as at this position, if it is remapped. */
export function replacementFor(name: string, x: number, y: number, z: number): string | undefined {
  const options = GRAVITY_BLOCK_REPLACEMENTS[name];
  if (!options) return undefined;
  const only = options.length === 1 ? options[0] : undefined;
  if (only) return only.name;
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
