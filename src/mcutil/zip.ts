/**
 * Minimal ZIP reader/writer (store + deflate).
 *
 * A `.mcworld` and a `.mcaddon` are both ordinary ZIP archives, so the only
 * archive features needed here are "read every entry" and "write entries".
 * Implementing them locally keeps the dependency list to the LevelDB driver.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** MS-DOS date/time encoding; a fixed stamp keeps builds reproducible. */
function dosDateTime(date = new Date(2026, 0, 1, 0, 0, 0)): { time: number; date: number } {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

interface ZipRecord {
  name: Buffer;
  crc: number;
  method: number;
  compressed: Buffer;
  uncompressedSize: number;
  offset: number;
}

export class ZipWriter {
  private records: ZipRecord[] = [];
  private chunks: Buffer[] = [];
  private offset = 0;
  private readonly stamp = dosDateTime();

  addFile(name: string, data: Buffer): void {
    const uncompressedSize = data.length;
    const crc = crc32(data);
    let method = 0;
    let compressed: Buffer = data;
    if (data.length > 128) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        compressed = deflated;
      }
    }
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.records.push({ name: nameBuf, crc, method, compressed, uncompressedSize, offset: this.offset });
    this.chunks.push(header, nameBuf, compressed);
    this.offset += header.length + nameBuf.length + compressed.length;
  }

  finish(): Buffer {
    const centralStart = this.offset;
    const central: Buffer[] = [];
    let centralSize = 0;
    for (const record of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(this.stamp.time, 12);
      header.writeUInt16LE(this.stamp.date, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(record.compressed.length, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(record.offset, 42);
      central.push(header, record.name);
      centralSize += header.length + record.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, ...central, end]);
  }
}

/** Reads every entry of a ZIP archive, inflating deflated entries. */
export function readZip(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`bad central directory entry at ${offset}`);
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`bad local file header for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    if (!name.endsWith("/")) entries.push({ name, data });
    offset = offset;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const min = Math.max(0, archive.length - 66_000);
  for (let i = archive.length - 22; i >= min; i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("not a ZIP archive (no end of central directory record)");
}
