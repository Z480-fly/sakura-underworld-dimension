/**
 * Bedrock subchunk payload decoder.
 *
 * Payload layout for subchunk version 9 (1.18+):
 *
 *   [0]    version u8 (9)
 *   [1]    storage count u8
 *   [2]    subchunk Y index i8 (v9 only)
 *   [3..]  storage layers, each:
 *            storageVersion u8  (bitsPerBlock << 1 | runtimePalette)
 *            words u32[]        ceil(4096 / (32 / bits)) little-endian words
 *            palette count u32
 *            palette entries    NBT compounds { name, states, version }
 *
 * A storage with `bitsPerBlock == 0` is uniform and holds exactly one palette
 * entry. The writer used by the source world omits the palette count in that
 * case, while Bedrock itself writes it, so both shapes are accepted: a count of
 * exactly 1 is treated as the count, anything else is rewound and treated as
 * the start of the palette entry.
 *
 * Indices are returned in raw packed order (position `p` in the payload is
 * `ids[p]`). Turning `p` into world coordinates is the caller's business - see
 * `BlockOrder` in `./layout.ts`, because the source world and Bedrock disagree
 * about it and both readings have to be measurable.
 */
import type { NbtCompound, NbtValue } from "../nbt/nbt.ts";
import { TAG, readNbtRoot } from "../nbt/nbt.ts";

export const SUBCHUNK_BLOCK_COUNT = 4096;

const BITS_CHOICES = [1, 2, 3, 4, 5, 6, 8, 16] as const;

export interface BlockStateEntry {
  name: string;
  states: Map<string, NbtValue>;
  version: number;
}

export interface DecodedSubChunk {
  version: number;
  subChunkIndex: number;
  palette: BlockStateEntry[];
  /** 4096 palette indices in raw packed order. */
  ids: Uint16Array;
}

export function bitsForPaletteSize(paletteSize: number): number {
  if (paletteSize <= 1) return 0;
  const needed = Math.ceil(Math.log2(paletteSize));
  for (const bits of BITS_CHOICES) {
    if (bits >= needed) return bits;
  }
  return 16;
}

function readPaletteEntry(buf: Buffer, offset: number): { entry: BlockStateEntry; offset: number } {
  const root = readNbtRoot(buf, offset);
  const nameValue = root.value.get("name");
  if (typeof nameValue?.value !== "string") {
    throw new Error(`palette entry at ${offset} has no name (tag types: ${[...root.value.keys()].join(",")})`);
  }
  const statesValue = root.value.get("states");
  const states = statesValue?.value instanceof Map ? (statesValue.value as NbtCompound) : new Map<string, NbtValue>();
  const versionValue = root.value.get("version");
  const version = typeof versionValue?.value === "number" ? versionValue.value : 0;
  return { entry: { name: nameValue.value, states, version }, offset: root.offset };
}

/** Decodes one `SubChunkPrefix` payload. */
export function decodeSubChunk(payload: Buffer): DecodedSubChunk {
  let pos = 0;
  const version = payload[pos++]!;
  if (version !== 8 && version !== 9) {
    throw new Error(`unsupported subchunk version ${version}`);
  }
  const storageCount = payload[pos++]!;
  let subChunkIndex = 0;
  if (version === 9) {
    subChunkIndex = payload.readInt8(pos);
    pos += 1;
  }

  let palette: BlockStateEntry[] = [];
  let ids = new Uint16Array(SUBCHUNK_BLOCK_COUNT);

  for (let storage = 0; storage < storageCount; storage++) {
    const storageVersion = payload[pos++]!;
    const bits = storageVersion >> 1;
    const runtimePalette = (storageVersion & 1) === 0;
    if (!runtimePalette) {
      throw new Error("network-id block palettes are not supported");
    }

    let layerIds = new Uint16Array(SUBCHUNK_BLOCK_COUNT);
    if (bits === 0) {
      // Uniform storage: one palette entry, no words. Bedrock writes a palette
      // count of 1 here; the source world's writer does not.
      let count = 0;
      if (pos + 4 <= payload.length && payload.readUInt32LE(pos) === 1) {
        count = 1;
        pos += 4;
      } else {
        count = 1;
      }
      const read = readPaletteEntry(payload, pos);
      pos = read.offset;
      palette = [read.entry];
      layerIds.fill(0);
    } else {
      const blocksPerWord = Math.floor(32 / bits);
      const wordCount = Math.ceil(SUBCHUNK_BLOCK_COUNT / blocksPerWord);
      const mask = (1 << bits) - 1;
      const words = new Uint32Array(wordCount);
      for (let i = 0; i < wordCount; i++) {
        words[i] = payload.readUInt32LE(pos);
        pos += 4;
      }
      const paletteSize = payload.readUInt32LE(pos);
      pos += 4;
      palette = [];
      for (let i = 0; i < paletteSize; i++) {
        const read = readPaletteEntry(payload, pos);
        pos = read.offset;
        palette.push(read.entry);
      }
      for (let i = 0; i < SUBCHUNK_BLOCK_COUNT; i++) {
        const word = words[Math.floor(i / blocksPerWord)]!;
        layerIds[i] = (word >>> ((i % blocksPerWord) * bits)) & mask;
      }
    }
    if (storage === 0) ids = layerIds;
  }

  if (palette.length === 0) palette = [{ name: "minecraft:air", states: new Map(), version: 0 }];
  return { version, subChunkIndex, palette, ids };
}

export function blockStateKey(entry: BlockStateEntry): string {
  if (entry.states.size === 0) return entry.name;
  const parts: string[] = [];
  for (const key of [...entry.states.keys()].sort()) {
    const value = entry.states.get(key)!;
    parts.push(`${key}=${String(value.value)}`);
  }
  return `${entry.name}[${parts.join(",")}]`;
}

export { TAG };
