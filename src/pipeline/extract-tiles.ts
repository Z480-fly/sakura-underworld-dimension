/**
 * Turns the existing Underworld world into structure tiles the add-on can place.
 *
 * Bedrock custom dimensions only support void generation - there is no way to
 * point a dimension at a prebuilt LevelDB - so the world has to be carried into
 * the dimension as data. The supported mechanism is a structure template:
 * `world.structureManager.place()` / `/structure load` both accept
 * `namespace:name` identifiers resolved from a behavior pack's `structures/`
 * folder, and structures placed into unloaded chunks are queued by the engine.
 *
 * This step reads the *existing* `.mcworld` (never regenerating it), decodes
 * every subchunk, and writes one `.mcstructure` per 64x64 footprint tile. Air
 * is stored as the structure format's "void" index (-1), so tiles only ever add
 * blocks and the files stay small.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlockOrder } from "../mcworld/layout.ts";
import { packedIndex } from "../mcworld/layout.ts";
import { writeMcStructure } from "../mcworld/mcstructure.ts";
import type { BlockStateEntry } from "../mcworld/subchunk.ts";
import { blockStateKey } from "../mcworld/subchunk.ts";
import { openUnderworldSource } from "../mcworld/source.ts";
import { detectOrder } from "../mcworld/detect.ts";
import { ADDON, PATHS, TILE_HEIGHT, TILE_SIZE } from "./config.ts";
import { fetchSourceWorld } from "./fetch-source.ts";

interface TileProbe {
  x: number;
  y: number;
  z: number;
  block: string;
}

interface ExtractedTile {
  id: string;
  x: number;
  y: number;
  z: number;
  sizeY: number;
  blocks: number;
  file: string;
  bytes: number;
  /**
   * One known block inside the tile. The behavior pack script reads this
   * position back with the game's own block API before it marks the tile as
   * done, so a tile is only ever recorded as placed once the terrain is really
   * there - and `/sakura:diagnose` uses the same points to report on the world.
   */
  probe: TileProbe;
}

export interface ExtractManifest {
  source: { repository: string; path: string; sha256: string; commit: string | null };
  order: BlockOrder;
  orderScores: Array<{ order: BlockOrder; roughness: number }>;
  realm: { minX: number; maxX: number; minZ: number; maxZ: number };
  spawn: { x: number; y: number; z: number };
  totals: { tiles: number; cells: number; blocks: number; structureBytes: number };
  tiles: ExtractedTile[];
}

const TILE_COLUMNS = TILE_SIZE * TILE_SIZE;

export async function extractTiles(): Promise<void> {
  const manifest = await fetchSourceWorld();
  const source = await openUnderworldSource({ mcworldPath: PATHS.sourceWorld, workDir: PATHS.workDir });
  const detection = detectOrder(source);
  const order = detection.best;

  console.log(
    `[extract] subchunk ordering: ${order} ` +
      `(roughness ${detection.scores.map((s) => `${s.order}=${s.roughness.toFixed(3)}`).join(" ")})`,
  );

  const minX = source.bounds.minChunkX * 16;
  const maxX = (source.bounds.maxChunkX + 1) * 16;
  const minZ = source.bounds.minChunkZ * 16;
  const maxZ = (source.bounds.maxChunkZ + 1) * 16;
  const worldHeight = 128;

  const structureDir = PATHS.structuresDir;
  await rm(structureDir, { recursive: true, force: true });
  await mkdir(structureDir, { recursive: true });

  // Palette index 0 is reserved for air; every other cell holds paletteIndex + 1.
  const palette: BlockStateEntry[] = [];
  const paletteIndex = new Map<string, number>();
  const cells = new Uint16Array(TILE_COLUMNS * worldHeight);

  const tiles: ExtractedTile[] = [];
  let totalCells = 0;
  let totalBlocks = 0;
  let totalBytes = 0;

  const tilesX = Math.ceil((maxX - minX) / TILE_SIZE);
  const tilesZ = Math.ceil((maxZ - minZ) / TILE_SIZE);

  for (let ix = 0; ix < tilesX; ix++) {
    for (let iz = 0; iz < tilesZ; iz++) {
      const x0 = minX + ix * TILE_SIZE;
      const z0 = minZ + iz * TILE_SIZE;

      cells.fill(0);
      let minY = worldHeight;
      let maxY = -1;
      let blocks = 0;
      const localPaletteIndex = new Map<number, number>();

      for (let cx = x0 >> 4; cx <= (x0 + TILE_SIZE - 1) >> 4; cx++) {
        for (let cz = z0 >> 4; cz <= (z0 + TILE_SIZE - 1) >> 4; cz++) {
          for (let subY = 0; subY < worldHeight >> 4; subY++) {
            const sub = source.subChunkAt(cx, cz, subY);
            if (!sub) continue;
            for (let ly = 0; ly < 16; ly++) {
              const y = subY * 16 + ly;
              for (let lz = 0; lz < 16; lz++) {
                const wz = cz * 16 + lz;
                const tz = wz - z0;
                if (tz < 0 || tz >= TILE_SIZE) continue;
                for (let lx = 0; lx < 16; lx++) {
                  const wx = cx * 16 + lx;
                  const tx = wx - x0;
                  if (tx < 0 || tx >= TILE_SIZE) continue;
                  const index = sub.ids[packedIndex(order, lx, ly, lz)];
                  const entry = index === undefined ? undefined : sub.palette[index];
                  if (!entry || entry.name === "minecraft:air") continue;
                  let paletteSlot = localPaletteIndex.get(index);
                  if (paletteSlot === undefined) {
                    const key = blockStateKey(entry);
                    let shared = paletteIndex.get(key);
                    if (shared === undefined) {
                      shared = palette.length;
                      palette.push(entry);
                      paletteIndex.set(key, shared);
                    }
                    paletteSlot = shared;
                    localPaletteIndex.set(index, shared);
                  }
                  cells[tx * worldHeight * TILE_SIZE + y * TILE_SIZE + tz] = paletteSlot + 1;
                  blocks++;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
            }
          }
        }
      }

      if (blocks === 0) continue;
      totalBlocks += blocks;

      for (let spanStart = minY; spanStart <= maxY; spanStart += TILE_HEIGHT) {
        const spanEnd = Math.min(spanStart + TILE_HEIGHT - 1, maxY);
        const sizeY = spanEnd - spanStart + 1;
        const indices = new Int32Array(TILE_COLUMNS * sizeY).fill(-1);
        const spanPalette: BlockStateEntry[] = [];
        const spanRemap = new Map<number, number>();
        let spanBlocks = 0;

        for (let tx = 0; tx < TILE_SIZE; tx++) {
          for (let ty = 0; ty < sizeY; ty++) {
            const y = spanStart + ty;
            for (let tz = 0; tz < TILE_SIZE; tz++) {
              const cell = cells[tx * worldHeight * TILE_SIZE + y * TILE_SIZE + tz]!;
              if (cell === 0) continue;
              const sourcePalette = cell - 1;
              let slot = spanRemap.get(sourcePalette);
              if (slot === undefined) {
                slot = spanPalette.length;
                spanPalette.push(palette[sourcePalette]!);
                spanRemap.set(sourcePalette, slot);
              }
              indices[tx * sizeY * TILE_SIZE + ty * TILE_SIZE + tz] = slot;
              spanBlocks++;
            }
          }
        }

        // Pick the topmost block of the column nearest the tile centre as the
        // probe: it is the position the game is asked to confirm later.
        let probe: TileProbe | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;
        const mid = (TILE_SIZE - 1) / 2;
        for (let tx = 0; tx < TILE_SIZE; tx++) {
          for (let tz = 0; tz < TILE_SIZE; tz++) {
            for (let ty = sizeY - 1; ty >= 0; ty--) {
              const value = indices[tx * sizeY * TILE_SIZE + ty * TILE_SIZE + tz]!;
              if (value < 0) continue;
              const distance = (tx - mid) * (tx - mid) + (tz - mid) * (tz - mid);
              if (distance < bestDistance) {
                bestDistance = distance;
                probe = { x: x0 + tx, y: spanStart + ty, z: z0 + tz, block: spanPalette[value]!.name };
              }
              break;
            }
          }
        }
        if (!probe) continue;

        const span = Math.floor((spanStart - minY) / TILE_HEIGHT);
        const name = `underworld_${ix}_${iz}_${span}`;
        const file = join(structureDir, `${name}.mcstructure`);
        const buffer = writeMcStructure({
          sizeX: TILE_SIZE,
          sizeY,
          sizeZ: TILE_SIZE,
          originX: x0,
          originY: spanStart,
          originZ: z0,
          palette: spanPalette,
          indices,
        });
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, buffer);
        totalCells += indices.length;
        totalBytes += buffer.length;
        tiles.push({
          id: `${ADDON.namespace}:${name}`,
          x: x0,
          y: spanStart,
          z: z0,
          sizeY,
          blocks: spanBlocks,
          file: `${ADDON.structureFolder}/${name}.mcstructure`,
          bytes: buffer.length,
          probe,
        });
      }
    }
  }

  const spawn = source.levelDat.spawn;
  await source.close();

  tiles.sort(
    (a, b) => distanceToSpawn(a, spawn) - distanceToSpawn(b, spawn) || a.y - b.y || a.x - b.x || a.z - b.z,
  );

  const extractManifest: ExtractManifest = {
    source: {
      repository: manifest.repository,
      path: manifest.path,
      sha256: manifest.sha256,
      commit: manifest.commit,
    },
    order,
    orderScores: detection.scores.map((score) => ({ order: score.order, roughness: score.roughness })),
    realm: { minX, maxX, minZ, maxZ },
    spawn,
    totals: { tiles: tiles.length, cells: totalCells, blocks: totalBlocks, structureBytes: totalBytes },
    tiles,
  };
  await mkdir(PATHS.dist, { recursive: true });
  await writeFile(PATHS.extractManifest, `${JSON.stringify(extractManifest, null, 2)}\n`);
  await writeRuntimeModule(extractManifest);

  console.log(
    `[extract] ${tiles.length} tiles, ${totalBlocks} blocks, ${totalCells} cells, ` +
      `${(totalBytes / 1024 / 1024).toFixed(2)} MB of structure data`,
  );
  console.log(`[extract] spawn ${JSON.stringify(spawn)}`);
}

function distanceToSpawn(tile: ExtractedTile, spawn: { x: number; y: number; z: number }): number {
  const cx = tile.x + TILE_SIZE / 2;
  const cz = tile.z + TILE_SIZE / 2;
  const dx = (cx - spawn.x) / TILE_SIZE;
  const dz = (cz - spawn.z) / TILE_SIZE;
  return dx * dx + dz * dz;
}

async function writeRuntimeModule(manifest: ExtractManifest): Promise<void> {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE - do not edit by hand.");
  lines.push(" *");
  lines.push(" * Produced by `src/pipeline/extract-tiles.ts` from the existing Underworld world:");
  lines.push(` *   ${manifest.source.repository}/${manifest.source.path}`);
  lines.push(` *   sha256 ${manifest.source.sha256}`);
  lines.push(` * Subchunk ordering used: ${manifest.order}`);
  lines.push(" */");
  lines.push("");
  lines.push("export interface TileProbe {");
  lines.push("  readonly x: number;");
  lines.push("  readonly y: number;");
  lines.push("  readonly z: number;");
  lines.push("  readonly block: string;");
  lines.push("}");
  lines.push("");
  lines.push("export interface UnderworldTile {");
  lines.push("  readonly id: string;");
  lines.push("  readonly x: number;");
  lines.push("  readonly y: number;");
  lines.push("  readonly z: number;");
  lines.push("  readonly sizeY: number;");
  lines.push("  readonly blocks: number;");
  lines.push("  readonly probe: TileProbe;");
  lines.push("}");
  lines.push("");
  lines.push("export const UNDERWORLD_SOURCE = {");
  lines.push(`  repository: ${JSON.stringify(manifest.source.repository)},`);
  lines.push(`  path: ${JSON.stringify(manifest.source.path)},`);
  lines.push(`  sha256: ${JSON.stringify(manifest.source.sha256)},`);
  lines.push(`  subChunkOrder: ${JSON.stringify(manifest.order)},`);
  lines.push("} as const;");
  lines.push("");
  lines.push(`export const UNDERWORLD_TILE_SIZE = ${TILE_SIZE};`);
  lines.push("");
  lines.push("export const UNDERWORLD_SPAWN: { x: number; y: number; z: number } = {");
  lines.push(`  x: ${manifest.spawn.x},`);
  lines.push(`  y: ${manifest.spawn.y},`);
  lines.push(`  z: ${manifest.spawn.z},`);
  lines.push("};");
  lines.push("");
  lines.push("export const UNDERWORLD_TILES: readonly UnderworldTile[] = [");
  for (const tile of manifest.tiles) {
    lines.push(
      `  { id: ${JSON.stringify(tile.id)}, x: ${tile.x}, y: ${tile.y}, z: ${tile.z}, ` +
        `sizeY: ${tile.sizeY}, blocks: ${tile.blocks},`,
    );
    lines.push(
      `    probe: { x: ${tile.probe.x}, y: ${tile.probe.y}, z: ${tile.probe.z}, ` +
        `block: ${JSON.stringify(tile.probe.block)} } },`,
    );
  }
  lines.push("];");
  lines.push("");
  await writeFile(PATHS.generatedMapModule, `${lines.join("\n")}`);
}

if (import.meta.main) await extractTiles();
