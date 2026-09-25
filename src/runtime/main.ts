/**
 * Sakura Underworld Dimension - behavior pack script.
 *
 * Responsibilities:
 *  1. The Enchanted Echo Shard: use it anywhere outside the Underworld and it
 *     records where you were, then moves you into the Underworld. Use it inside
 *     the Underworld and it puts you back exactly where you left.
 *  2. Filling the Underworld: Bedrock custom dimensions only support void
 *     generation, so the dimension arrives empty and is filled from the
 *     structure tiles extracted out of the existing Underworld world.
 *
 * A tile is only ever recorded as done once the game itself reports the terrain
 * at the tile's probe block, and tiles whose chunks are not loaded are left for
 * later rather than queued blindly - so the terrain cannot end up permanently
 * missing because a chunk was never visited.
 */
import { ItemStack, Player, system, world } from "@minecraft/server";
import type { Dimension, Vector2, Vector3 } from "@minecraft/server";
import { parseReturn, roundCoordinate, serializeReturn } from "./return-location.js";
import type { UnderworldTile } from "./underworld-map.js";
import { UNDERWORLD_SOURCE, UNDERWORLD_SPAWN, UNDERWORLD_TILES, UNDERWORLD_TILE_SIZE } from "./underworld-map.js";

const DIMENSION_ID = "sakura:underworld";
const SHARD_ID = "sakura:enchanted_echo_shard";

const RETURN_KEY = "sakura:return_location";
const BUILT_KEY = "sakura:underworld_built";
const DIAGNOSTIC_KEY = "sakura:diagnostics";

/** Tiles handled per game tick while the dimension is being filled. */
const TILES_PER_TICK = 1;
/** How often one tile may be placed before the script gives up on it. */
const MAX_ATTEMPTS = 4;
/** Ticks the arrival area is force-loaded before the player is moved in. */
const ARRIVAL_WAIT_TICKS = 100;
/** Ticks between two uses of the shard, to absorb duplicate use events. */
const USE_COOLDOWN_TICKS = 20;

const ARRIVAL_AREA_ID = "sakura_arrival";

const COLOR = {
  dark: "\u00a75",
  gray: "\u00a77",
  green: "\u00a7a",
  red: "\u00a7c",
  yellow: "\u00a7e",
};

const doneTiles = new Set<string>();
const placedTiles = new Set<string>();
const attempts = new Map<string, number>();
const lastUseTick = new Map<string, number>();
let pendingTiles: UnderworldTile[] = [];

let structuresReady = true;
let dimension: Dimension | undefined;
let initialised = false;
let arrivalAreaHeld = false;
let announcedReady = false;

// ---------------------------------------------------------------- persistence

function loadDoneTiles(): void {
  doneTiles.clear();
  const raw = world.getDynamicProperty(BUILT_KEY);
  if (typeof raw !== "string" || raw.length === 0) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) if (typeof entry === "string") doneTiles.add(entry);
    }
  } catch {
    doneTiles.clear();
  }
}

function saveDoneTiles(): void {
  world.setDynamicProperty(BUILT_KEY, JSON.stringify([...doneTiles]));
}

function loadReturn(): ReturnType<typeof parseReturn> {
  return parseReturn(world.getDynamicProperty(RETURN_KEY));
}

function saveReturn(player: Player): void {
  const rotation = safeRotation(player);
  const location = player.location;
  world.setDynamicProperty(
    RETURN_KEY,
    serializeReturn({
      dimension: player.dimension.id,
      x: roundCoordinate(location.x),
      y: roundCoordinate(location.y),
      z: roundCoordinate(location.z),
      pitch: roundCoordinate(rotation.x),
      yaw: roundCoordinate(rotation.y),
    }),
  );
}

function safeRotation(player: Player): Vector2 {
  try {
    return player.getRotation();
  } catch {
    return { x: 0, y: 0 };
  }
}

// ------------------------------------------------------------------ dimension

function resolveDimension(): Dimension | undefined {
  if (dimension) return dimension;
  try {
    dimension = world.getDimension(DIMENSION_ID);
    return dimension;
  } catch {
    return undefined;
  }
}

function prepareTileQueue(): void {
  pendingTiles = UNDERWORLD_TILES.filter((tile) => !doneTiles.has(tile.id));
  sortByDistanceToSpawn(pendingTiles);
}

function sortByDistanceToSpawn(tiles: UnderworldTile[]): void {
  const distance = (tile: UnderworldTile): number => {
    const cx = tile.x + UNDERWORLD_TILE_SIZE / 2;
    const cz = tile.z + UNDERWORLD_TILE_SIZE / 2;
    const dx = (cx - UNDERWORLD_SPAWN.x) / UNDERWORLD_TILE_SIZE;
    const dz = (cz - UNDERWORLD_SPAWN.z) / UNDERWORLD_TILE_SIZE;
    return dx * dx + dz * dz;
  };
  tiles.sort((a, b) => distance(a) - distance(b) || a.y - b.y);
}

/** True when the game reports the tile's probe block exactly as extracted. */
function probeMatches(dim: Dimension, tile: UnderworldTile): boolean | undefined {
  let block;
  try {
    block = dim.getBlock({ x: tile.probe.x, y: tile.probe.y, z: tile.probe.z });
  } catch {
    return undefined; // chunk not loaded
  }
  return block?.typeId === tile.probe.block;
}

function placeTile(dim: Dimension, tile: UnderworldTile): boolean {
  if (structuresReady) {
    try {
      world.structureManager.place(tile.id, dim, { x: tile.x, y: tile.y, z: tile.z });
      return true;
    } catch (error) {
      structuresReady = false;
      console.warn(`[sakura] structure manager could not place ${tile.id}: ${String(error)}`);
    }
  }
  try {
    const result = dim.runCommand(`structure load ${tile.id} ${tile.x} ${tile.y} ${tile.z}`);
    if (result.successCount === 0) throw new Error("structure load reported no success");
    return true;
  } catch (error) {
    const count = (attempts.get(tile.id) ?? 0) + 1;
    attempts.set(tile.id, count);
    if (count <= 2) console.warn(`[sakura] could not place ${tile.id}: ${String(error)}`);
    return false;
  }
}

function tickBuild(): void {
  if (!initialised) onStartup();
  if (pendingTiles.length === 0) return;
  const dim = resolveDimension();
  if (!dim) return;

  let work = 0;
  let index = 0;
  while (index < pendingTiles.length && work < TILES_PER_TICK) {
    const tile = pendingTiles[index]!;

    if (placedTiles.has(tile.id)) {
      if (probeMatches(dim, tile) === true) {
        placedTiles.delete(tile.id);
        doneTiles.add(tile.id);
        pendingTiles.splice(index, 1);
        saveDoneTiles();
        work++;
        continue;
      }
      if ((attempts.get(tile.id) ?? 0) >= MAX_ATTEMPTS) {
        console.warn(`[sakura] giving up on ${tile.id} after ${attempts.get(tile.id)} attempts`);
        placedTiles.delete(tile.id);
        pendingTiles.splice(index, 1);
        continue;
      }
      index++;
      continue;
    }

    if (probeMatches(dim, tile) === undefined) {
      // Chunk not loaded: leave it pending so it is built when it is reachable.
      index++;
      continue;
    }
    if (probeMatches(dim, tile) === true) {
      doneTiles.add(tile.id);
      pendingTiles.splice(index, 1);
      saveDoneTiles();
      work++;
      continue;
    }

    attempts.set(tile.id, (attempts.get(tile.id) ?? 0) + 1);
    if (placeTile(dim, tile)) {
      placedTiles.add(tile.id);
      work++;
    } else if ((attempts.get(tile.id) ?? 0) >= MAX_ATTEMPTS) {
      pendingTiles.splice(index, 1);
      continue;
    } else {
      index++;
    }
  }

  if (work === 0) return;
  if (pendingTiles.length === 0 && announcedReady) {
    announcedReady = false;
    world.sendMessage(`${COLOR.dark}[Sakura] ${COLOR.green}The Underworld is fully formed (${doneTiles.size} tiles).`);
  }
}

function reportedTiles(): { matched: number; mismatched: number; unloaded: number } {
  const dim = resolveDimension();
  const result = { matched: 0, mismatched: 0, unloaded: 0 };
  if (!dim) return result;
  for (const tile of UNDERWORLD_TILES) {
    const match = probeMatches(dim, tile);
    if (match === undefined) result.unloaded++;
    else if (match) result.matched++;
    else result.mismatched++;
  }
  return result;
}

/** Tiles near the spawn whose probe cannot be confirmed yet. */
function arrivalTilesOutstanding(): number {
  const dim = resolveDimension();
  if (!dim) return 0;
  let outstanding = 0;
  for (const tile of UNDERWORLD_TILES) {
    const away =
      Math.max(
        Math.abs(tile.x + UNDERWORLD_TILE_SIZE / 2 - UNDERWORLD_SPAWN.x),
        Math.abs(tile.z + UNDERWORLD_TILE_SIZE / 2 - UNDERWORLD_SPAWN.z),
      ) / UNDERWORLD_TILE_SIZE;
    if (away > 1.5) continue;
    if (probeMatches(dim, tile) !== true) outstanding++;
  }
  return outstanding;
}

async function holdArrivalArea(dim: Dimension): Promise<void> {
  if (arrivalAreaHeld) return;
  for (const radius of [96, 64, 32]) {
    try {
      await world.tickingAreaManager.createTickingArea(ARRIVAL_AREA_ID, {
        dimension: dim,
        from: { x: UNDERWORLD_SPAWN.x - radius, y: 0, z: UNDERWORLD_SPAWN.z - radius },
        to: { x: UNDERWORLD_SPAWN.x + radius, y: 127, z: UNDERWORLD_SPAWN.z + radius },
      });
      arrivalAreaHeld = true;
      console.warn(`[sakura] holding a ${radius * 2 + 1} block arrival area loaded`);
      return;
    } catch (error) {
      console.warn(`[sakura] arrival area radius ${radius} refused: ${String(error)}`);
    }
  }
}

function releaseArrivalArea(): void {
  if (!arrivalAreaHeld) return;
  arrivalAreaHeld = false;
  try {
    world.tickingAreaManager.removeTickingArea(ARRIVAL_AREA_ID);
  } catch (error) {
    console.warn(`[sakura] could not release the arrival area: ${String(error)}`);
  }
}

/** Force-loads and builds the tiles the player lands in, then lets them go. */
async function prepareArrival(dim: Dimension): Promise<void> {
  await holdArrivalArea(dim);
  for (let tick = 0; tick < ARRIVAL_WAIT_TICKS; tick++) {
    if (arrivalTilesOutstanding() === 0) break;
    await sleep(1);
  }
  releaseArrivalArea();
}

// ------------------------------------------------------------------- movement

function sleep(ticks: number): Promise<void> {
  return new Promise((resolve) => {
    system.runTimeout(() => resolve(), ticks);
  });
}

async function teleportTo(player: Player, target: Dimension, location: Vector3, rotation?: Vector2): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const options: { dimension: Dimension; rotation?: Vector2 } = { dimension: target };
      if (rotation) options.rotation = rotation;
      player.teleport({ x: location.x, y: location.y, z: location.z }, options);
      if (player.dimension.id === target.id) return true;
    } catch (error) {
      if (attempt === 3) console.warn(`[sakura] teleport failed: ${String(error)}`);
    }
    await sleep(2);
  }
  return false;
}

/** If the player arrives with nothing under them, drop them onto the terrain. */
function settle(player: Player): void {
  try {
    const location = player.location;
    const below = player.dimension.getBlock({
      x: Math.floor(location.x),
      y: Math.floor(location.y) - 1,
      z: Math.floor(location.z),
    });
    if (below && !below.isAir) return;
  } catch {
    return;
  }
  const origin = player.location;
  for (let radius = 0; radius <= UNDERWORLD_TILE_SIZE / 2; radius += 4) {
    for (let dx = -radius; dx <= radius; dx += 4) {
      for (let dz = -radius; dz <= radius; dz += 4) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = Math.floor(origin.x) + dx;
        const z = Math.floor(origin.z) + dz;
        try {
          for (let y = 118; y >= 0; y--) {
            const block = player.dimension.getBlock({ x, y, z });
            if (block && !block.isAir) {
              player.teleport({ x: x + 0.5, y: y + 1, z: z + 0.5 });
              return;
            }
          }
        } catch {
          return;
        }
      }
    }
  }
}

async function useShard(player: Player): Promise<void> {
  if (!initialised) onStartup();
  const currentDimension = player.dimension.id;

  if (currentDimension !== DIMENSION_ID) {
    const dim = resolveDimension();
    if (!dim) {
      player.sendMessage(`${COLOR.red}[Sakura] ${COLOR.gray}The Underworld is not available in this world.`);
      return;
    }
    saveReturn(player);
    player.sendMessage(`${COLOR.dark}[Sakura] ${COLOR.gray}The Underworld is opening...`);
    await prepareArrival(dim);
    const arrived = await teleportTo(player, dim, UNDERWORLD_SPAWN);
    if (!arrived) {
      player.sendMessage(`${COLOR.red}[Sakura] ${COLOR.gray}The Underworld refused to open. Try again.`);
      return;
    }
    announcedReady = true;
    player.sendMessage(
      pendingTiles.length > 0
        ? `${COLOR.dark}[Sakura] ${COLOR.gray}The Underworld settles around you... ` +
            `${COLOR.yellow}${pendingTiles.length}${COLOR.gray} tiles still forming.`
        : `${COLOR.dark}[Sakura] ${COLOR.green}Welcome back to the Underworld.`,
    );
    settle(player);
    return;
  }

  const saved = loadReturn();
  if (!saved) {
    player.sendMessage(`${COLOR.red}[Sakura] ${COLOR.gray}No return location is saved yet.`);
    return;
  }
  let target: Dimension;
  try {
    target = world.getDimension(saved.dimension);
  } catch {
    player.sendMessage(`${COLOR.red}[Sakura] ${COLOR.gray}The saved dimension is gone.`);
    return;
  }
  const returned = await teleportTo(
    player,
    target,
    { x: saved.x, y: saved.y, z: saved.z },
    { x: saved.pitch, y: saved.yaw },
  );
  if (!returned) {
    player.sendMessage(`${COLOR.red}[Sakura] ${COLOR.gray}The way back would not open. Try again.`);
    return;
  }
  player.sendMessage(`${COLOR.dark}[Sakura] ${COLOR.green}You return to ${saved.dimension}.`);
}

// ------------------------------------------------------------------ reporting

function log(message: string): void {
  console.log(`[sakura][diagnose] ${message}`);
}

/**
 * Prints a full report through the console/content log: whether the dimension
 * and item registered, how many of the extracted tiles the game can see and
 * confirm, and whether the stored data survived the previous session.
 *
 * Trigger it with `/sakura:diagnose` or `scriptevent sakura:diagnose`.
 */
function diagnose(): void {
  log(`dimension ${DIMENSION_ID}: ${resolveDimension() ? "registered" : "MISSING"}`);

  try {
    const stack = new ItemStack(SHARD_ID, 1);
    log(`item ${SHARD_ID}: ${stack.typeId === SHARD_ID ? "registered" : `unexpected id ${stack.typeId}`}`);
  } catch (error) {
    log(`item ${SHARD_ID}: MISSING (${String(error)})`);
  }

  try {
    const known = new Set(world.structureManager.getPackStructureIds());
    const visible = UNDERWORLD_TILES.filter((tile) => known.has(tile.id)).length;
    log(`structures visible from the pack: ${visible}/${UNDERWORLD_TILES.length}`);
  } catch (error) {
    log(`structure list unavailable: ${String(error)}`);
  }

  const dim = resolveDimension();
  const report = reportedTiles();
  log(
    `terrain probes: ${report.matched}/${UNDERWORLD_TILES.length} match the source world, ` +
      `${report.mismatched} wrong, ${report.unloaded} in unloaded chunks`,
  );
  log(`build bookkeeping: ${doneTiles.size} done, ${placedTiles.size} awaiting confirmation, ${pendingTiles.length} pending`);
  log(`world tiles expected from ${UNDERWORLD_SOURCE.repository}`);

  if (dim) {
    const mismatches: string[] = [];
    for (const tile of UNDERWORLD_TILES) {
      if (probeMatches(dim, tile) !== false) continue;
      let actual: string;
      try {
        actual = dim.getBlock({ x: tile.probe.x, y: tile.probe.y, z: tile.probe.z })?.typeId ?? "air";
      } catch {
        actual = "unloaded";
      }
      mismatches.push(
        `${tile.id} at ${tile.probe.x},${tile.probe.y},${tile.probe.z}: ` +
          `expected ${tile.probe.block}, found ${actual}`,
      );
    }
    for (const line of mismatches.slice(0, 8)) log(`mismatch: ${line}`);
    if (mismatches.length > 8) log(`... and ${mismatches.length - 8} more mismatches`);

    try {
      const block = dim.getBlock({ x: UNDERWORLD_SPAWN.x, y: UNDERWORLD_SPAWN.y, z: UNDERWORLD_SPAWN.z });
      const ground = dim.getBlock({ x: UNDERWORLD_SPAWN.x, y: UNDERWORLD_SPAWN.y - 1, z: UNDERWORLD_SPAWN.z });
      log(
        `spawn ${UNDERWORLD_SPAWN.x},${UNDERWORLD_SPAWN.y},${UNDERWORLD_SPAWN.z}: ` +
          `at=${block?.typeId ?? "unloaded"} below=${ground?.typeId ?? "unloaded"}`,
      );
    } catch (error) {
      log(`spawn column unreadable: ${String(error)}`);
    }
  }

  const previous = world.getDynamicProperty(DIAGNOSTIC_KEY);
  log(`diagnostic marker carried over from the previous session: ${previous === undefined ? "(none)" : String(previous)}`);
  world.setDynamicProperty(DIAGNOSTIC_KEY, new Date().toISOString());
  const saved = loadReturn();
  log(`saved return location: ${saved ? JSON.stringify(saved) : "(none)"}`);
}

// ----------------------------------------------------------------------- entry

function onStartup(): void {
  if (initialised) return;
  initialised = true;
  loadDoneTiles();
  prepareTileQueue();
  console.log(
    `[sakura] Underworld source ${UNDERWORLD_SOURCE.repository} (${UNDERWORLD_TILES.length} tiles), ` +
      `${pendingTiles.length} left to place`,
  );
}

world.afterEvents.worldLoad.subscribe(() => {
  onStartup();
  const dim = resolveDimension();
  if (!dim) {
    console.warn(
      "[sakura] custom dimension sakura:underworld was not registered. " +
        "Enable the Custom Dimensions / Beta APIs experiment for this world.",
    );
    return;
  }
  world.sendMessage(
    `${COLOR.dark}[Sakura] ${COLOR.gray}Hold an ${COLOR.yellow}Enchanted Echo Shard${COLOR.gray} ` +
      `and use it to enter the Underworld.`,
  );
});

world.afterEvents.itemUse.subscribe((event) => {
  const source = event.source;
  if (!(source instanceof Player)) return;
  if (event.itemStack?.typeId !== SHARD_ID) return;

  const last = lastUseTick.get(source.id);
  if (last !== undefined && system.currentTick - last < USE_COOLDOWN_TICKS) return;
  lastUseTick.set(source.id, system.currentTick);

  void useShard(source);
});

system.runInterval(() => {
  tickBuild();
}, 1);

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "sakura:diagnose") return;
  diagnose();
});

system.beforeEvents.startup.subscribe((event) => {
  // A new dimension identifier can only be created during startup, and the
  // documented route is the script registry. The data-driven
  // dimensions/underworld.json may have registered it already, in which case
  // this throws CustomDimensionAlreadyRegisteredError and is harmlessly
  // ignored - either way sakura:underworld exists by the time play begins.
  try {
    event.dimensionRegistry.registerCustomDimension(DIMENSION_ID);
    console.log(`[sakura] registered custom dimension ${DIMENSION_ID}`);
  } catch (error) {
    console.warn(`[sakura] script registration of ${DIMENSION_ID} was not needed: ${String(error)}`);
  }

  try {
    event.customCommandRegistry.registerCommand(
      {
        name: "sakura:diagnose",
        description: "Report the state of the Sakura Underworld dimension",
        permissionLevel: 0,
        cheatsRequired: false,
      },
      () => {
        system.run(() => diagnose());
        return undefined;
      },
    );
  } catch (error) {
    console.warn(`[sakura] could not register the diagnostic command: ${String(error)}`);
  }

  try {
    event.customCommandRegistry.registerCommand(
      {
        name: "sakura:enter_underworld",
        description: "Enter or leave the Sakura Underworld",
        permissionLevel: 0,
        cheatsRequired: false,
      },
      (origin) => {
        const entity = origin.sourceEntity;
        if (entity instanceof Player) {
          system.run(() => {
            void useShard(entity);
          });
        }
        return undefined;
      },
    );
  } catch (error) {
    console.warn(`[sakura] could not register the helper command: ${String(error)}`);
  }
});
