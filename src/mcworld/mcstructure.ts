/**
 * `.mcstructure` writer.
 *
 * A structure template is little-endian NBT:
 *
 *   format_version : int (1)
 *   size           : list<int>[x, y, z]
 *   structure      : {
 *     block_indices: list<list<int>>[primary, secondary]
 *     entities     : list<compound>
 *     palette      : { default: { block_palette: list<compound>, block_position_data: compound } }
 *   }
 *   structure_world_origin : list<int>[x, y, z]
 *
 * The index lists run x-major, then y, then z (`index = x * sizeY * sizeZ + y * sizeZ + z`)
 * and must hold exactly `sizeX * sizeY * sizeZ` entries each. `-1` means "no block",
 * which is how air is stored here: the tile then leaves whatever is already in the
 * dimension alone instead of punching holes into it.
 */
import type { NbtValue } from "../nbt/nbt.ts";
import { ByteWriter, TAG, writeTagged } from "../nbt/nbt.ts";
import type { BlockStateEntry } from "./subchunk.ts";

/** Block-state data version the source palette entries carry. */
export const DEFAULT_BLOCK_STATE_VERSION = 18163713;

export interface StructureTile {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  originX: number;
  originY: number;
  originZ: number;
  palette: BlockStateEntry[];
  /** Length must be sizeX * sizeY * sizeZ; -1 marks a void cell. */
  indices: Int32Array;
}

function writePaletteEntry(w: ByteWriter, entry: BlockStateEntry, fallbackVersion: number): void {
  // `block_palette` is an ordinary NBT list, so its compound elements carry no
  // tag byte and no name - just the members and a terminating End tag.
  w.named(TAG.String, "name");
  w.str(entry.name);
  w.named(TAG.Compound, "states");
  for (const key of [...entry.states.keys()].sort()) {
    const value: NbtValue = entry.states.get(key)!;
    w.named(value.type, key);
    writeTagged(w, value);
  }
  w.u8(TAG.End);
  w.named(TAG.Int, "version");
  w.i32le(entry.version || fallbackVersion);
  w.u8(TAG.End);
}

function writeIntList(w: ByteWriter, values: Int32Array): void {
  w.u8(TAG.Int);
  w.i32le(values.length);
  w.raw(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

export function writeMcStructure(tile: StructureTile): Buffer {
  const cellCount = tile.sizeX * tile.sizeY * tile.sizeZ;
  if (tile.indices.length !== cellCount) {
    throw new Error(`tile has ${tile.indices.length} indices but ${cellCount} cells`);
  }
  const fallbackVersion = tile.palette[0]?.version || DEFAULT_BLOCK_STATE_VERSION;
  const w = new ByteWriter(1024 + cellCount * 8 + tile.palette.length * 64);

  w.u8(TAG.Compound);
  w.str("");

  w.named(TAG.Int, "format_version");
  w.i32le(1);

  w.named(TAG.List, "size");
  w.u8(TAG.Int);
  w.i32le(3);
  w.i32le(tile.sizeX);
  w.i32le(tile.sizeY);
  w.i32le(tile.sizeZ);

  w.named(TAG.Compound, "structure");

  w.named(TAG.List, "block_indices");
  w.u8(TAG.List);
  w.i32le(2);
  writeIntList(w, tile.indices);
  writeIntList(w, new Int32Array(cellCount).fill(-1));

  // No entities are ever written: the source world has no entity records and the
  // add-on must not introduce any.
  w.named(TAG.List, "entities");
  w.u8(TAG.Compound);
  w.i32le(0);

  w.named(TAG.Compound, "palette");
  w.named(TAG.Compound, "default");
  w.named(TAG.List, "block_palette");
  w.u8(TAG.Compound);
  w.i32le(tile.palette.length);
  for (const entry of tile.palette) writePaletteEntry(w, entry, fallbackVersion);
  w.named(TAG.Compound, "block_position_data");
  w.u8(TAG.End);
  w.u8(TAG.End); // default
  w.u8(TAG.End); // palette

  w.u8(TAG.End); // structure

  w.named(TAG.List, "structure_world_origin");
  w.u8(TAG.Int);
  w.i32le(3);
  w.i32le(tile.originX);
  w.i32le(tile.originY);
  w.i32le(tile.originZ);

  w.u8(TAG.End); // root
  return w.toBuffer();
}
