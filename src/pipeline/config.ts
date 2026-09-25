/** Shared paths, identifiers and version stamps for the whole build. */
import { join } from "node:path";

export const PROJECT_ROOT = process.cwd();

export const SOURCE = {
  /** Repository that actually contains the Underworld world. */
  repo: "Z480-fly/unstable-underworld-bedrock",
  /** The world artifact inside that repository. */
  path: "dist/Underworld-Simulator-Remastered.mcworld",
  branch: "main",
} as const;

export const PATHS = {
  sourceDir: join(PROJECT_ROOT, "source"),
  sourceWorld: join(PROJECT_ROOT, "source", "Underworld-Simulator-Remastered.mcworld"),
  sourceManifest: join(PROJECT_ROOT, "source", "SOURCE.json"),
  workDir: join(PROJECT_ROOT, "build", "world-copy"),
  structuresDir: join(PROJECT_ROOT, "build", "structures"),
  addonDir: join(PROJECT_ROOT, "build", "addon"),
  behaviorPack: join(PROJECT_ROOT, "build", "addon", "SakuraUnderworldBP"),
  resourcePack: join(PROJECT_ROOT, "build", "addon", "SakuraUnderworldRP"),
  staticBehaviorPack: join(PROJECT_ROOT, "src", "addon", "behavior_pack"),
  staticResourcePack: join(PROJECT_ROOT, "src", "addon", "resource_pack"),
  runtimeSource: join(PROJECT_ROOT, "src", "runtime", "main.ts"),
  generatedMapModule: join(PROJECT_ROOT, "src", "runtime", "underworld-map.ts"),
  extractManifest: join(PROJECT_ROOT, "build", "extract-manifest.json"),
  dist: join(PROJECT_ROOT, "dist"),
  addon: join(PROJECT_ROOT, "dist", "SakuraUnderworldDimension.mcaddon"),
} as const;

export const ADDON = {
  /** Custom dimension declared in the behavior pack. */
  dimensionId: "sakura:underworld",
  biomeId: "sakura:underworld",
  itemId: "sakura:enchanted_echo_shard",
  textureKey: "sakura_enchanted_echo_shard",
  namespace: "sakura",
  behaviorPackName: "Sakura Underworld Dimension BP",
  resourcePackName: "Sakura Underworld Dimension RP",
  behaviorPackFolder: "SakuraUnderworldBP",
  resourcePackFolder: "SakuraUnderworldRP",
  /** Structure tiles live under <BP>/structures/sakura/<...>.mcstructure. */
  structureFolder: "structures/sakura",
  scriptEntry: "scripts/main.js",
  minEngineVersion: [1, 26, 50] as [number, number, number],
  serverModuleVersion: "beta",
  behaviorPackUuid: "9d1c6b7a-4f2e-4d3a-9f0b-6a2c7e5d1b30",
  behaviorScriptUuid: "3a7e9c14-5b62-4a0d-8e71-2c4f6a9d0b51",
  resourcePackUuid: "c5f0a83d-1e47-4b96-8c23-7d5e9a1f4b62",
} as const;

/** Footprint of one structure tile, in blocks. */
export const TILE_SIZE = 64;
/** Maximum height of one structure tile; taller tiles are split into spans. */
export const TILE_HEIGHT = 64;
