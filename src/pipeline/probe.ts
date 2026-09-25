/**
 * Diagnostics: report both subchunk readings of the source world.
 *
 * `bun run src/pipeline/probe.ts`
 */
import { detectOrder, heightAt, scoreOrder } from "../mcworld/detect.ts";
import { describeOrder } from "../mcworld/layout.ts";
import { openUnderworldSource } from "../mcworld/source.ts";
import { PATHS } from "./config.ts";
import { fetchSourceWorld } from "./fetch-source.ts";

const manifest = await fetchSourceWorld();
const source = await openUnderworldSource({ mcworldPath: PATHS.sourceWorld, workDir: PATHS.workDir });

console.log(`[probe] source: ${manifest.repository}/${manifest.path}`);
console.log(`[probe] level.dat storage version ${source.levelDat.storageVersion}, name "${source.levelDat.levelName}"`);
console.log(
  `[probe] realm chunks x ${source.bounds.minChunkX}..${source.bounds.maxChunkX} ` +
    `z ${source.bounds.minChunkZ}..${source.bounds.maxChunkZ}`,
);
console.log(
  `[probe] ${source.stats.levelDbKeys} leveldb keys, ${source.stats.chunks} chunks, ` +
    `${source.stats.subChunks} subchunk payloads`,
);
console.log(`[probe] spawn ${JSON.stringify(source.levelDat.spawn)}`);

for (const order of ["bedrock", "generator"] as const) {
  const score = scoreOrder(source, order);
  console.log(
    `[probe] ${order.padEnd(9)} ${describeOrder(order).padEnd(30)} ` +
      `roughness ${score.roughness.toFixed(3)}  land ${score.landColumns}  solid ${score.solidBlocks}`,
  );
}

const detection = detectOrder(source);
console.log(`[probe] detected ordering: ${detection.best} (margin x${detection.margin.toFixed(2)})`);

const spawn = source.levelDat.spawn;
for (const order of ["bedrock", "generator"] as const) {
  const below = source.blockAt(order, spawn.x, spawn.y - 1, spawn.z);
  const at = source.blockAt(order, spawn.x, spawn.y, spawn.z);
  console.log(
    `[probe] ${order.padEnd(9)} spawn column: below=${below?.name ?? "air"} at=${at?.name ?? "air"}`,
  );
}

for (const order of ["bedrock", "generator"] as const) {
  const step = 8;
  const minX = source.bounds.minChunkX * 16;
  const maxX = (source.bounds.maxChunkX + 1) * 16;
  const minZ = source.bounds.minChunkZ * 16;
  const maxZ = (source.bounds.maxChunkZ + 1) * 16;
  const lines: string[] = [];
  for (let z = minZ; z < maxZ; z += step) {
    let line = "";
    for (let x = minX; x < maxX; x += step) {
      const height = heightAt(source, order, x, z);
      line += height === undefined ? " " : height >= 60 ? "#" : height >= 40 ? "+" : ".";
    }
    lines.push(line);
  }
  console.log(`[probe] land mask (${order} reading, '#'=high '+'=plate '.'=low ' '=void):`);
  for (const line of lines) console.log(`  ${line}`);
}

await source.close();
