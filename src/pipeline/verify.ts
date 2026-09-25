/**
 * Verifies the built `.mcaddon`.
 *
 * This is the gate that answers "did the existing Underworld world actually
 * make it into the package?": it opens the finished archive, walks every tile
 * the runtime script will place, parses each `.mcstructure` and adds up the
 * blocks it contains, then compares the total against the number of non-air
 * blocks counted in the source world.
 *
 * `bun run src/pipeline/verify.ts`
 */
import { readFile } from "node:fs/promises";
import { ADDON, PATHS } from "./config.ts";
import type { ExtractManifest } from "./extract-tiles.ts";
import { inspectMcStructure, structureCellCount } from "../mcworld/inspect-mcstructure.ts";
import { GRAVITY_BLOCKS } from "./remap.ts";
import { UNDERWORLD_TILES } from "../runtime/underworld-map.ts";
import { readZip } from "../mcutil/zip.ts";

interface Failure {
  area: string;
  detail: string;
}

class Report {
  readonly failures: Failure[] = [];
  checks = 0;

  check(condition: boolean, area: string, detail: string): boolean {
    this.checks++;
    if (!condition) this.failures.push({ area, detail });
    return condition;
  }

  fail(area: string, detail: string): void {
    this.failures.push({ area, detail });
  }
}

interface Manifest {
  header?: { name?: string; uuid?: string; version?: number[]; min_engine_version?: number[] };
  modules?: Array<{ type?: string; uuid?: string; entry?: string; language?: string }>;
  dependencies?: Array<{ uuid?: string; module_name?: string; version?: unknown }>;
}

function parseJson<T>(report: Report, area: string, text: string | undefined): T | undefined {
  if (text === undefined) {
    report.fail(area, "file is missing");
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    report.fail(area, `invalid JSON: ${String(error)}`);
    return undefined;
  }
}

export async function verifyAddon(): Promise<void> {
  const report = new Report();
  const manifest = JSON.parse(await readFile(PATHS.extractManifest, "utf8")) as ExtractManifest;
  const archive = await readFile(PATHS.addon);
  const entries = new Map(readZip(archive).map((entry) => [entry.name, entry.data]));

  console.log(`[verify] ${PATHS.addon} - ${(archive.length / 1024 / 1024).toFixed(2)} MB, ${entries.size} entries`);

  const bpPrefix = `${ADDON.behaviorPackFolder}/`;
  const rpPrefix = `${ADDON.resourcePackFolder}/`;

  // ---- manifests -----------------------------------------------------------
  const bpManifest = parseJson<Manifest>(report, "bp manifest", entries.get(`${bpPrefix}manifest.json`)?.toString("utf8"));
  const rpManifest = parseJson<Manifest>(report, "rp manifest", entries.get(`${rpPrefix}manifest.json`)?.toString("utf8"));
  const uuids = new Set<string>();
  for (const [area, value] of [
    ["bp manifest", bpManifest],
    ["rp manifest", rpManifest],
  ] as const) {
    if (!value) continue;
    const uuid = value.header?.uuid;
    report.check(typeof uuid === "string" && uuid.length > 0, area, "header.uuid is missing");
    if (typeof uuid === "string") {
      report.check(!uuids.has(uuid), area, `duplicate pack uuid ${uuid}`);
      uuids.add(uuid);
    }
    for (const module of value.modules ?? []) {
      if (typeof module.uuid === "string") {
        report.check(!uuids.has(module.uuid), area, `duplicate module uuid ${module.uuid}`);
        uuids.add(module.uuid);
      }
    }
  }
  report.check(
    (bpManifest?.modules ?? []).some((module) => module.type === "script" && module.entry === ADDON.scriptEntry),
    "bp manifest",
    `no script module with entry ${ADDON.scriptEntry}`,
  );
  report.check(
    (bpManifest?.modules ?? []).some((module) => module.type === "data"),
    "bp manifest",
    "no data module",
  );
  report.check(
    (rpManifest?.modules ?? []).some((module) => module.type === "resources"),
    "rp manifest",
    "no resources module",
  );
  report.check(
    (bpManifest?.dependencies ?? []).some((dependency) => dependency.uuid === rpManifest?.header?.uuid),
    "bp manifest",
    "the behavior pack does not depend on the resource pack",
  );
  report.check(
    (bpManifest?.dependencies ?? []).some((dependency) => dependency.module_name === "@minecraft/server"),
    "bp manifest",
    "the behavior pack does not depend on @minecraft/server",
  );
  // Both packs ship as one release and the behavior pack pins the resource pack
  // by version. Bumping only one of them leaves Minecraft resolving the older
  // cached pack, which is what makes a rebuilt add-on look unchanged in game.
  const bpVersion = bpManifest?.header?.version?.join(".");
  const rpVersion = rpManifest?.header?.version?.join(".");
  report.check(
    bpVersion !== undefined && bpVersion === rpVersion,
    "manifests",
    `the packs carry different versions: bp ${bpVersion ?? "?"}, rp ${rpVersion ?? "?"}`,
  );
  const pinnedRp = (bpManifest?.dependencies ?? []).find(
    (dependency) => dependency.uuid === rpManifest?.header?.uuid,
  )?.version;
  report.check(
    Array.isArray(pinnedRp) && pinnedRp.join(".") === rpVersion,
    "manifests",
    `the behavior pack pins the resource pack at ${JSON.stringify(pinnedRp)}, not ${rpVersion ?? "?"}`,
  );

  // ---- dimension, biome, item ---------------------------------------------
  const dimension = parseJson<{ "minecraft:dimension"?: { description?: { identifier?: string } } }>(
    report,
    "dimension",
    entries.get(`${bpPrefix}dimensions/underworld.json`)?.toString("utf8"),
  );
  report.check(
    dimension?.["minecraft:dimension"]?.description?.identifier === ADDON.dimensionId,
    "dimension",
    `identifier is ${dimension?.["minecraft:dimension"]?.description?.identifier}, expected ${ADDON.dimensionId}`,
  );

  const biome = parseJson<{ "minecraft:biome"?: { description?: { identifier?: string } } }>(
    report,
    "biome",
    entries.get(`${bpPrefix}biomes/underworld.json`)?.toString("utf8"),
  );
  report.check(
    biome?.["minecraft:biome"]?.description?.identifier === ADDON.biomeId,
    "biome",
    `identifier is ${biome?.["minecraft:biome"]?.description?.identifier}, expected ${ADDON.biomeId}`,
  );

  const item = parseJson<{ "minecraft:item"?: { description?: { identifier?: string }; components?: Record<string, unknown> } }>(
    report,
    "item",
    entries.get(`${bpPrefix}items/enchanted_echo_shard.json`)?.toString("utf8"),
  );
  report.check(
    item?.["minecraft:item"]?.description?.identifier === ADDON.itemId,
    "item",
    `identifier is ${item?.["minecraft:item"]?.description?.identifier}, expected ${ADDON.itemId}`,
  );
  report.check(
    item?.["minecraft:item"]?.components?.["minecraft:glint"] === true,
    "item",
    "the item does not have the enchantment glint",
  );
  report.check(
    item?.["minecraft:item"]?.components?.["minecraft:allow_off_hand"] === true,
    "item",
    "the item cannot be placed in the off-hand slot",
  );

  const textures = parseJson<{ texture_data?: Record<string, { textures?: string }> }>(
    report,
    "item texture",
    entries.get(`${rpPrefix}textures/item_texture.json`)?.toString("utf8"),
  );
  report.check(
    textures?.texture_data?.[ADDON.textureKey]?.textures === "textures/items/echo_shard",
    "item texture",
    `the ${ADDON.textureKey} icon does not point at the vanilla echo shard texture`,
  );

  // ---- scripts -------------------------------------------------------------
  report.check(entries.has(`${bpPrefix}${ADDON.scriptEntry}`), "script", `missing ${ADDON.scriptEntry}`);
  report.check(
    entries.has(`${bpPrefix}scripts/underworld-map.js`),
    "script",
    "missing the generated underworld-map.js the script imports",
  );

  // ---- the world itself ----------------------------------------------------
  report.check(manifest.totals.tiles > 0, "world", "the extraction produced no tiles");
  report.check(manifest.order === "generator", "world", `unexpected subchunk ordering ${manifest.order}`);
  report.check(
    UNDERWORLD_TILES.length === manifest.totals.tiles,
    "script data",
    `the runtime module lists ${UNDERWORLD_TILES.length} tiles but ${manifest.totals.tiles} were extracted`,
  );
  const runtimeIds = new Set(UNDERWORLD_TILES.map((tile) => tile.id));
  for (const tile of manifest.tiles) {
    if (!runtimeIds.has(tile.id)) report.fail("script data", `${tile.id} is missing from the runtime module`);
  }

  const gravityFound = new Set<string>();
  let verifiedBlocks = 0;
  let verifiedCells = 0;
  let missing = 0;
  for (const tile of manifest.tiles) {
    const entry = entries.get(`${bpPrefix}${tile.file}`);
    if (!entry) {
      missing++;
      if (missing <= 5) report.fail("structures", `missing ${tile.file}`);
      continue;
    }
    let summary;
    try {
      summary = inspectMcStructure(entry);
    } catch (error) {
      report.fail("structures", `${tile.file} is not a readable structure: ${String(error)}`);
      continue;
    }
    const cells = structureCellCount(summary.size);
    if (summary.formatVersion !== 1) report.fail("structures", `${tile.file} format_version is ${summary.formatVersion}`);
    if (summary.size[0] !== 64 || summary.size[2] !== 64) {
      report.fail("structures", `${tile.file} footprint is ${summary.size[0]}x${summary.size[2]}, expected 64x64`);
    }
    if (summary.size[1] !== tile.sizeY) {
      report.fail("structures", `${tile.file} height is ${summary.size[1]}, expected ${tile.sizeY}`);
    }
    if (summary.indexLayerLengths.length !== 2) {
      report.fail("structures", `${tile.file} has ${summary.indexLayerLengths.length} block index layers, expected 2`);
    }
    for (const length of summary.indexLayerLengths) {
      if (length !== cells) report.fail("structures", `${tile.file} has ${length} indices for ${cells} cells`);
    }
    if (summary.paletteSize === 0) report.fail("structures", `${tile.file} has an empty block palette`);
    for (const name of summary.paletteNames) if (GRAVITY_BLOCKS.includes(name)) gravityFound.add(name);
    if (summary.origin[0] !== tile.x || summary.origin[1] !== tile.y || summary.origin[2] !== tile.z) {
      report.fail(
        "structures",
        `${tile.file} origin ${summary.origin.join(",")} does not match tile ${tile.x},${tile.y},${tile.z}`,
      );
    }
    verifiedBlocks += tile.blocks;
    verifiedCells += cells;
  }
  report.check(missing === 0, "structures", `${missing} structure files are missing from the package`);
  report.check(
    verifiedBlocks === manifest.totals.blocks,
    "world",
    `the package holds ${verifiedBlocks} blocks but the source world supplied ${manifest.totals.blocks}`,
  );
  report.check(
    verifiedCells >= manifest.totals.blocks,
    "world",
    `the tiles cover ${verifiedCells} cells, fewer than the ${manifest.totals.blocks} blocks they contain`,
  );
  report.check(
    gravityFound.size === 0,
    "structures",
    `the tiles still hold falling blocks, which would drop out of the terrain: ${[...gravityFound].join(", ")}`,
  );

  // ---- summary -------------------------------------------------------------
  console.log(`[verify] source world: ${manifest.source.repository}/${manifest.source.path}`);
  console.log(`[verify]              sha256 ${manifest.source.sha256}`);
  console.log(`[verify]              commit ${manifest.source.commit ?? "unknown"}`);
  console.log(`[verify] subchunk ordering: ${manifest.order}`);
  console.log(`[verify] realm ${manifest.realm.minX}..${manifest.realm.maxX} x ${manifest.realm.minZ}..${manifest.realm.maxZ}`);
  console.log(`[verify] spawn ${JSON.stringify(manifest.spawn)}`);
  for (const remap of manifest.remap) {
    console.log(`[verify] ${remap.blocks} falling ${remap.from} written as ${remap.to.join(" / ")}`);
  }
  console.log(
    `[verify] ${manifest.totals.tiles} tiles, ${verifiedBlocks} blocks in ${verifiedCells} structure cells`,
  );

  if (report.failures.length > 0) {
    console.error(`\n[verify] ${report.failures.length} of ${report.checks} checks FAILED:`);
    for (const failure of report.failures.slice(0, 40)) console.error(`  - [${failure.area}] ${failure.detail}`);
    process.exit(1);
  }
  console.log(`[verify] OK - ${report.checks} checks passed, the Underworld world is in the package`);
}

if (import.meta.main) await verifyAddon();
