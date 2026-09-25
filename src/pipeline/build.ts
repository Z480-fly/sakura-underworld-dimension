/**
 * Full build: fetch the Underworld world, bake it into structure tiles, assemble
 * the `.mcaddon`, then verify the result.
 *
 * `bun run build:addon`
 */
import { assembleAddon } from "./build-addon.ts";
import { extractTiles } from "./extract-tiles.ts";
import { fetchSourceWorld } from "./fetch-source.ts";
import { verifyAddon } from "./verify.ts";

const started = performance.now();
const step = (name: string): void => {
  console.log(`\n=== ${name} (${((performance.now() - started) / 1000).toFixed(1)}s) ===`);
};

step("fetch the existing Underworld world");
await fetchSourceWorld();

step("extract the world into structure tiles");
await extractTiles();

step("assemble the .mcaddon");
await assembleAddon();

step("verify");
await verifyAddon();

console.log(`\nbuild finished in ${((performance.now() - started) / 1000).toFixed(1)}s`);
