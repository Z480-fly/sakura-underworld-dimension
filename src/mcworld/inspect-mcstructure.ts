/**
 * Structural read-back of a `.mcstructure`, used by the verifier.
 *
 * It walks the NBT without materialising the block index lists - a 64x64x64
 * tile holds 262 144 ints per layer and there are two layers per tile - so
 * checking every tile stays fast and cheap on memory.
 */
import { TAG } from "../nbt/nbt.ts";

export interface McStructureSummary {
  formatVersion: number;
  size: [number, number, number];
  origin: [number, number, number];
  indexLayerLengths: number[];
  paletteSize: number;
  /** The block names in `palette.default.block_palette`. */
  paletteNames: string[];
  entities: number;
  bytes: number;
}

interface Cursor {
  buf: Buffer;
  pos: number;
}

function readString(c: Cursor): string {
  const length = c.buf.readUInt16LE(c.pos);
  c.pos += 2 + length;
  return c.buf.toString("utf8", c.pos - length, c.pos);
}

function skipPayload(c: Cursor, type: number): void {
  switch (type) {
    case TAG.Byte:
      c.pos += 1;
      break;
    case TAG.Short:
      c.pos += 2;
      break;
    case TAG.Int:
    case TAG.Float:
      c.pos += 4;
      break;
    case TAG.Long:
    case TAG.Double:
      c.pos += 8;
      break;
    case TAG.ByteArray:
      c.pos += 4 + c.buf.readInt32LE(c.pos);
      break;
    case TAG.String:
      readString(c);
      break;
    case TAG.List: {
      const elementType = c.buf[c.pos++]!;
      const length = c.buf.readInt32LE(c.pos);
      c.pos += 4;
      if (elementType === TAG.End) break;
      for (let i = 0; i < length; i++) skipPayload(c, elementType);
      break;
    }
    case TAG.Compound:
      for (;;) {
        const childType = c.buf[c.pos++]!;
        if (childType === TAG.End) break;
        readString(c);
        skipPayload(c, childType);
      }
      break;
    case TAG.IntArray:
      c.pos += 4 + c.buf.readInt32LE(c.pos) * 4;
      break;
    default:
      throw new Error(`unsupported NBT tag 0x${type.toString(16)}`);
  }
}

export function inspectMcStructure(buffer: Buffer): McStructureSummary {
  const c: Cursor = { buf: buffer, pos: 0 };
  if (c.buf[c.pos++] !== TAG.Compound) throw new Error("structure root is not a compound");
  readString(c);

  const summary: McStructureSummary = {
    formatVersion: 0,
    size: [0, 0, 0],
    origin: [0, 0, 0],
    indexLayerLengths: [],
    paletteSize: 0,
    paletteNames: [],
    entities: 0,
    bytes: buffer.length,
  };

  for (;;) {
    const type = c.buf[c.pos++]!;
    if (type === TAG.End) break;
    const name = readString(c);

    if (name === "size" && type === TAG.List) {
      c.pos += 1; // element type
      const count = c.buf.readInt32LE(c.pos);
      c.pos += 4;
      if (count !== 3) throw new Error(`size list holds ${count} entries, expected 3`);
      summary.size = [c.buf.readInt32LE(c.pos), c.buf.readInt32LE(c.pos + 4), c.buf.readInt32LE(c.pos + 8)];
      c.pos += 12;
      continue;
    }

    if (name === "format_version" && type === TAG.Int) {
      summary.formatVersion = c.buf.readInt32LE(c.pos);
      c.pos += 4;
      continue;
    }

    if (name === "structure_world_origin" && type === TAG.List) {
      c.pos += 1;
      const count = c.buf.readInt32LE(c.pos);
      c.pos += 4;
      if (count === 3) {
        summary.origin = [c.buf.readInt32LE(c.pos), c.buf.readInt32LE(c.pos + 4), c.buf.readInt32LE(c.pos + 8)];
      }
      c.pos += count * 4;
      continue;
    }

    if (name === "structure" && type === TAG.Compound) {
      for (;;) {
        const childType = c.buf[c.pos++]!;
        if (childType === TAG.End) break;
        const childName = readString(c);
        if (childName === "block_indices" && childType === TAG.List) {
          c.pos += 1; // element type is Tag_List
          const layers = c.buf.readInt32LE(c.pos);
          c.pos += 4;
          for (let layer = 0; layer < layers; layer++) {
            const layerType = c.buf[c.pos++]!;
            if (layerType !== TAG.Int) throw new Error(`block_indices layer ${layer} is tag 0x${layerType.toString(16)}`);
            const length = c.buf.readInt32LE(c.pos);
            c.pos += 4;
            summary.indexLayerLengths.push(length);
            c.pos += length * 4;
          }
          continue;
        }
        if (childName === "entities" && childType === TAG.List) {
          const elementType = c.buf[c.pos++]!;
          const count = c.buf.readInt32LE(c.pos);
          c.pos += 4;
          summary.entities = count;
          for (let i = 0; i < count; i++) skipPayload(c, elementType);
          continue;
        }
        if (childName === "palette" && childType === TAG.Compound) {
          for (;;) {
            const paletteType = c.buf[c.pos++]!;
            if (paletteType === TAG.End) break;
            const paletteName = readString(c);
            if (paletteName === "default" && paletteType === TAG.Compound) {
              for (;;) {
                const defaultType = c.buf[c.pos++]!;
                if (defaultType === TAG.End) break;
                const defaultName = readString(c);
                if (defaultName === "block_palette" && defaultType === TAG.List) {
                  const elementType = c.buf[c.pos++]!;
                  const count = c.buf.readInt32LE(c.pos);
                  c.pos += 4;
                  summary.paletteSize = count;
                  for (let i = 0; i < count; i++) {
                    // List elements of a compound list are unnamed, so the entry's
                    // own `name` member has to be walked to be read.
                    if (elementType !== TAG.Compound) {
                      skipPayload(c, elementType);
                      continue;
                    }
                    for (;;) {
                      const memberType = c.buf[c.pos++]!;
                      if (memberType === TAG.End) break;
                      const memberName = readString(c);
                      if (memberName === "name" && memberType === TAG.String) {
                        summary.paletteNames.push(readString(c));
                        continue;
                      }
                      skipPayload(c, memberType);
                    }
                  }
                  continue;
                }
                skipPayload(c, defaultType);
              }
              continue;
            }
            skipPayload(c, paletteType);
          }
          continue;
        }
        skipPayload(c, childType);
      }
      continue;
    }

    skipPayload(c, type);
  }

  return summary;
}

export function structureCellCount(size: [number, number, number]): number {
  return size[0] * size[1] * size[2];
}
