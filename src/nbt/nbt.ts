/**
 * Minimal little-endian NBT reader/writer (Bedrock flavour).
 *
 * Bedrock NBT stores multi-byte integers and string lengths little-endian and
 * prefixes strings with an unsigned 16-bit byte length. Only the tags this
 * project actually touches are implemented: every scalar, string, list,
 * compound, byte array and int array.
 *
 * Values are kept tagged (`{ type, value }`) because block states must be
 * written back with the exact NBT type they arrived with - Bedrock treats a
 * boolean state written as an int differently from one written as a byte.
 */
export const TAG = {
  End: 0x00,
  Byte: 0x01,
  Short: 0x02,
  Int: 0x03,
  Long: 0x04,
  Float: 0x05,
  Double: 0x06,
  ByteArray: 0x07,
  String: 0x08,
  List: 0x09,
  Compound: 0x0a,
  IntArray: 0x0b,
} as const;

export interface NbtValue {
  readonly type: number;
  readonly value: unknown;
}

export type NbtCompound = Map<string, NbtValue>;

interface Cursor {
  buf: Buffer;
  pos: number;
}

function need(c: Cursor, bytes: number): void {
  if (c.pos + bytes > c.buf.length) {
    throw new RangeError(`NBT truncated: wanted ${bytes} bytes at offset ${c.pos} of ${c.buf.length}`);
  }
}

function u8(c: Cursor): number {
  need(c, 1);
  return c.buf[c.pos++]!;
}

function i16(c: Cursor): number {
  need(c, 2);
  const v = c.buf.readInt16LE(c.pos);
  c.pos += 2;
  return v;
}

function i32(c: Cursor): number {
  need(c, 4);
  const v = c.buf.readInt32LE(c.pos);
  c.pos += 4;
  return v;
}

function i64(c: Cursor): bigint {
  need(c, 8);
  const v = c.buf.readBigInt64LE(c.pos);
  c.pos += 8;
  return v;
}

function str(c: Cursor): string {
  need(c, 2);
  const length = c.buf.readUInt16LE(c.pos);
  c.pos += 2;
  need(c, length);
  const value = c.buf.toString("utf8", c.pos, c.pos + length);
  c.pos += length;
  return value;
}

function payload(c: Cursor, type: number): unknown {
  switch (type) {
    case TAG.Byte:
      return u8(c);
    case TAG.Short:
      return i16(c);
    case TAG.Int:
      return i32(c);
    case TAG.Long:
      return i64(c);
    case TAG.Float:
      need(c, 4);
      {
        const v = c.buf.readFloatLE(c.pos);
        c.pos += 4;
        return v;
      }
    case TAG.Double:
      need(c, 8);
      {
        const v = c.buf.readDoubleLE(c.pos);
        c.pos += 8;
        return v;
      }
    case TAG.ByteArray: {
      const length = i32(c);
      need(c, length);
      const v = Buffer.from(c.buf.subarray(c.pos, c.pos + length));
      c.pos += length;
      return v;
    }
    case TAG.String:
      return str(c);
    case TAG.List: {
      const elementType = u8(c);
      const length = i32(c);
      const items: unknown[] = [];
      for (let i = 0; i < length; i++) items.push(payload(c, elementType));
      return items;
    }
    case TAG.Compound: {
      const compound: NbtCompound = new Map();
      for (;;) {
        const childType = u8(c);
        if (childType === TAG.End) break;
        const name = str(c);
        compound.set(name, { type: childType, value: payload(c, childType) });
      }
      return compound;
    }
    case TAG.IntArray: {
      const length = i32(c);
      const items: number[] = [];
      for (let i = 0; i < length; i++) items.push(i32(c));
      return items;
    }
    default:
      throw new Error(`unsupported NBT tag 0x${type.toString(16)}`);
  }
}

/** Reads one named root tag (the shape `level.dat` and palette entries use). */
export function readNbtRoot(buffer: Buffer, start = 0): { name: string; value: NbtCompound; offset: number } {
  const cursor: Cursor = { buf: buffer, pos: start };
  const type = u8(cursor);
  if (type === TAG.End) return { name: "", value: new Map(), offset: cursor.pos };
  const name = str(cursor);
  const value = payload(cursor, type);
  if (!(value instanceof Map)) throw new Error(`root tag is 0x${type.toString(16)}, not a compound`);
  return { name, value: value as NbtCompound, offset: cursor.pos };
}

export function compoundGet(compound: NbtCompound, key: string): NbtValue | undefined {
  return compound.get(key);
}

export function compoundInt(compound: NbtCompound, key: string): number | undefined {
  const entry = compound.get(key);
  return typeof entry?.value === "number" ? entry.value : undefined;
}

export function compoundString(compound: NbtCompound, key: string): string | undefined {
  const entry = compound.get(key);
  return typeof entry?.value === "string" ? entry.value : undefined;
}

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buf: Buffer;
  private len = 0;

  constructor(initialSize = 1024) {
    this.buf = Buffer.allocUnsafe(initialSize);
  }

  private ensure(extra: number): void {
    const need2 = this.len + extra;
    if (need2 <= this.buf.length) return;
    let cap = this.buf.length === 0 ? 64 : this.buf.length;
    while (cap < need2) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  i8(v: number): void {
    this.u8(v);
  }

  u16le(v: number): void {
    this.ensure(2);
    this.buf.writeUInt16LE(v & 0xffff, this.len);
    this.len += 2;
  }

  i16le(v: number): void {
    this.ensure(2);
    this.buf.writeInt16LE(v | 0, this.len);
    this.len += 2;
  }

  i32le(v: number): void {
    this.ensure(4);
    this.buf.writeInt32LE(v | 0, this.len);
    this.len += 4;
  }

  i64le(v: bigint): void {
    this.ensure(8);
    this.buf.writeBigInt64LE(v, this.len);
    this.len += 8;
  }

  f32le(v: number): void {
    this.ensure(4);
    this.buf.writeFloatLE(v, this.len);
    this.len += 4;
  }

  f64le(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.len);
    this.len += 8;
  }

  raw(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  /** Bedrock string: u16 LE byte length + UTF-8 bytes. */
  str(s: string): void {
    const bytes = Buffer.from(s, "utf8");
    this.u16le(bytes.length);
    this.raw(bytes);
  }

  /** Named tag header for a compound member. */
  named(type: number, name: string): void {
    this.u8(type);
    this.str(name);
  }

  get length(): number {
    return this.len;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

/** Writes a payload using the NBT type it was read with. */
export function writeTagged(w: ByteWriter, entry: NbtValue): void {
  switch (entry.type) {
    case TAG.Byte:
      w.i8(Number(entry.value));
      break;
    case TAG.Short:
      w.i16le(Number(entry.value));
      break;
    case TAG.Int:
      w.i32le(Number(entry.value));
      break;
    case TAG.Long:
      w.i64le(BigInt(entry.value as bigint));
      break;
    case TAG.Float:
      w.f32le(Number(entry.value));
      break;
    case TAG.Double:
      w.f64le(Number(entry.value));
      break;
    case TAG.String:
      w.str(String(entry.value));
      break;
    default:
      throw new Error(`unsupported state tag 0x${entry.type.toString(16)}`);
  }
}
