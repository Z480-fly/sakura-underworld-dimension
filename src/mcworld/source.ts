/**
 * Reader for the existing Underworld world.
 *
 * The source artifact is the `.mcworld` published by
 * `Z480-fly/unstable-underworld-bedrock`. It is a ZIP holding a Bedrock
 * LevelDB, so the reader unpacks a working copy of `db/` + `level.dat`, walks
 * every key and indexes the `SubChunkPrefix` payloads. Nothing is ever written
 * back into the source world - the extraction only reads it.
 */
import { ClassicLevel } from "classic-level";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BlockOrder } from "./layout.ts";
import { packedIndex } from "./layout.ts";
import type { BlockStateEntry, DecodedSubChunk } from "./subchunk.ts";
import { decodeSubChunk } from "./subchunk.ts";
import { compoundInt, compoundString, readNbtRoot } from "../nbt/nbt.ts";
import { readZip } from "../mcutil/zip.ts";

export const CHUNK_TAG = {
  Data3D: 0x2b,
  Version: 0x2c,
  Data2D: 0x2d,
  SubChunkPrefix: 0x2f,
  FinalizedState: 0x36,
} as const;

export interface RealmBounds {
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
}

export interface UnderworldStats {
  levelDbKeys: number;
  chunks: number;
  subChunks: number;
  namedKeys: string[];
}

export interface ChunkKeyInfo {
  cx: number;
  cz: number;
  dimension: number;
  tag: number;
  subChunkIndex?: number;
}

export function decodeChunkKey(key: Buffer): ChunkKeyInfo | undefined {
  if (key.length !== 9 && key.length !== 10 && key.length !== 13 && key.length !== 14) return undefined;
  const cx = key.readInt32LE(0);
  const cz = key.readInt32LE(4);
  const withDimension = key.length === 13 || key.length === 14;
  const offset = withDimension ? 12 : 8;
  return {
    cx,
    cz,
    dimension: withDimension ? key.readInt32LE(8) : 0,
    tag: key.readUInt8(offset),
    subChunkIndex: key.length === offset + 2 ? key.readInt8(offset + 1) : undefined,
  };
}

export interface LevelDatInfo {
  storageVersion: number;
  levelName: string;
  spawn: { x: number; y: number; z: number };
}

export function parseLevelDat(buffer: Buffer): LevelDatInfo {
  const storageVersion = buffer.readUInt32LE(0);
  const length = buffer.readUInt32LE(4);
  const root = readNbtRoot(buffer.subarray(8, 8 + length), 0);
  return {
    storageVersion,
    levelName: compoundString(root.value, "LevelName") ?? "Underworld",
    spawn: {
      x: compoundInt(root.value, "SpawnX") ?? 0,
      y: compoundInt(root.value, "SpawnY") ?? 64,
      z: compoundInt(root.value, "SpawnZ") ?? 0,
    },
  };
}

export class UnderworldSource {
  private readonly decoded = new Map<string, DecodedSubChunk>();
  private readonly payloads: Map<string, Buffer[]>;
  private readonly chunkIds: Set<string>;

  constructor(
    private readonly db: ClassicLevel<Buffer, Buffer>,
    payloads: Map<string, Buffer[]>,
    chunkIds: Set<string>,
    readonly bounds: RealmBounds,
    readonly levelDat: LevelDatInfo,
    readonly stats: UnderworldStats,
  ) {
    this.payloads = payloads;
    this.chunkIds = chunkIds;
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunkIds.has(`${cx},${cz}`);
  }

  chunkCoordinates(): Array<{ cx: number; cz: number }> {
    return [...this.chunkIds].map((id) => {
      const [cx, cz] = id.split(",");
      return { cx: Number(cx), cz: Number(cz) };
    });
  }

  subChunkAt(cx: number, cz: number, subY: number): DecodedSubChunk | undefined {
    const layers = this.payloads.get(`${cx},${cz}`);
    if (!layers) return undefined;
    const payload = layers[subY + 64];
    if (!payload) return undefined;
    const cacheKey = `${cx},${cz},${subY}`;
    const cached = this.decoded.get(cacheKey);
    if (cached) return cached;
    const decoded = decodeSubChunk(payload);
    if (this.decoded.size > 4096) this.decoded.clear();
    this.decoded.set(cacheKey, decoded);
    return decoded;
  }

  /** Reads a block using the given subchunk ordering. */
  blockAt(order: BlockOrder, x: number, y: number, z: number): BlockStateEntry | undefined {
    const cx = x >> 4;
    const cz = z >> 4;
    const subY = y >> 4;
    const sub = this.subChunkAt(cx, cz, subY);
    if (!sub) return undefined;
    const localX = x & 15;
    const localY = y & 15;
    const localZ = z & 15;
    const index = sub.ids[packedIndex(order, localX, localY, localZ)];
    if (index === undefined) return undefined;
    const entry = sub.palette[index];
    if (!entry || entry.name === "minecraft:air") return undefined;
    return entry;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export interface OpenOptions {
  /** Path to the `.mcworld` archive. */
  mcworldPath: string;
  /** Scratch directory the working copy is unpacked into. */
  workDir: string;
}

export async function openUnderworldSource(options: OpenOptions): Promise<UnderworldSource> {
  const archive = await readFile(options.mcworldPath);
  const entries = readZip(archive);
  const memberNames = new Set(entries.map((entry) => entry.name));
  for (const required of ["level.dat", "levelname.txt"]) {
    if (!memberNames.has(required)) throw new Error(`${options.mcworldPath} is missing ${required}`);
  }

  await rm(options.workDir, { recursive: true, force: true });
  await mkdir(join(options.workDir, "db"), { recursive: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("db/")) continue;
    const target = join(options.workDir, entry.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  const levelDatEntry = entries.find((entry) => entry.name === "level.dat")!;
  await writeFile(join(options.workDir, "level.dat"), levelDatEntry.data);
  const levelDat = parseLevelDat(levelDatEntry.data);

  const db = new ClassicLevel<Buffer, Buffer>(join(options.workDir, "db"), {
    keyEncoding: "buffer",
    valueEncoding: "buffer",
  });
  await db.open();

  const payloads = new Map<string, Buffer[]>();
  const chunkIds = new Set<string>();
  const namedKeys: string[] = [];
  let levelDbKeys = 0;
  let subChunks = 0;
  let minChunkX = Number.POSITIVE_INFINITY;
  let maxChunkX = Number.NEGATIVE_INFINITY;
  let minChunkZ = Number.POSITIVE_INFINITY;
  let maxChunkZ = Number.NEGATIVE_INFINITY;

  for await (const [key, value] of db.iterator()) {
    levelDbKeys++;
    const info = decodeChunkKey(key);
    if (!info) {
      const text = key.toString("latin1");
      if (/^[\x20-\x7e]+$/.test(text)) namedKeys.push(text);
      continue;
    }
    const id = `${info.cx},${info.cz}`;
    chunkIds.add(id);
    if (info.cx < minChunkX) minChunkX = info.cx;
    if (info.cx > maxChunkX) maxChunkX = info.cx;
    if (info.cz < minChunkZ) minChunkZ = info.cz;
    if (info.cz > maxChunkZ) maxChunkZ = info.cz;
    if (info.tag === CHUNK_TAG.SubChunkPrefix && info.subChunkIndex !== undefined) {
      let layers = payloads.get(id);
      if (!layers) {
        layers = new Array<Buffer>(128);
        payloads.set(id, layers);
      }
      layers[info.subChunkIndex + 64] = value;
      subChunks++;
    }
  }

  if (subChunks === 0) throw new Error("the source world contains no subchunks");

  return new UnderworldSource(
    db,
    payloads,
    chunkIds,
    { minChunkX, maxChunkX, minChunkZ, maxChunkZ },
    levelDat,
    { levelDbKeys, chunks: chunkIds.size, subChunks, namedKeys },
  );
}
