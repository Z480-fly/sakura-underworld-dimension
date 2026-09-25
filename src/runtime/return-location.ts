/**
 * The record the Enchanted Echo Shard saves when it takes a player out of the
 * main world, kept separate from the script so it can be unit tested without
 * the game engine.
 *
 * It is stored in a world dynamic property, which Bedrock persists in the
 * world's own data - that is what makes the return location survive closing and
 * reopening the world and leaving and rejoining.
 */
export interface SavedLocation {
  /** Dimension id, e.g. "minecraft:overworld". */
  dimension: string;
  x: number;
  y: number;
  z: number;
  /** Pitch, -90..90. */
  pitch: number;
  /** Yaw, -180..180. */
  yaw: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function serializeReturn(location: SavedLocation): string {
  return JSON.stringify({
    dimension: location.dimension,
    x: location.x,
    y: location.y,
    z: location.z,
    pitch: location.pitch,
    yaw: location.yaw,
  });
}

/** Reads a stored record back, rejecting anything that could not be teleported to. */
export function parseReturn(raw: unknown): SavedLocation | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.dimension !== "string" || record.dimension.length === 0) return undefined;
  if (!finite(record.x) || !finite(record.y) || !finite(record.z)) return undefined;
  return {
    dimension: record.dimension,
    x: record.x,
    y: record.y,
    z: record.z,
    pitch: finite(record.pitch) ? record.pitch : 0,
    yaw: finite(record.yaw) ? record.yaw : 0,
  };
}

/** Rounds to two decimals: enough precision, and keeps the stored JSON small. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}
