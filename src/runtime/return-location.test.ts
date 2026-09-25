import { describe, expect, test } from "bun:test";
import { parseReturn, roundCoordinate, serializeReturn } from "./return-location.ts";

describe("return location", () => {
  const location = { dimension: "minecraft:overworld", x: 12.5, y: 64, z: -31.25, pitch: -12.3, yaw: 178.4 };

  test("round trips through the stored form", () => {
    expect(parseReturn(serializeReturn(location))).toEqual(location);
  });

  test("survives a JSON round trip unchanged", () => {
    expect(JSON.parse(serializeReturn(location))).toEqual(location);
  });

  test("rejects anything that is not a usable location", () => {
    expect(parseReturn(undefined)).toBeUndefined();
    expect(parseReturn("")).toBeUndefined();
    expect(parseReturn("not json")).toBeUndefined();
    expect(parseReturn("[]")).toBeUndefined();
    expect(parseReturn("null")).toBeUndefined();
    expect(parseReturn(JSON.stringify({ x: 1, y: 2, z: 3 }))).toBeUndefined();
    expect(parseReturn(JSON.stringify({ dimension: "minecraft:overworld", x: "1", y: 2, z: 3 }))).toBeUndefined();
    expect(parseReturn(JSON.stringify({ dimension: "minecraft:overworld", x: 1, y: 2, z: Number.NaN }))).toBeUndefined();
  });

  test("defaults a missing rotation instead of dropping the location", () => {
    const parsed = parseReturn(JSON.stringify({ dimension: "minecraft:the_nether", x: 1, y: 2, z: 3 }));
    expect(parsed).toEqual({ dimension: "minecraft:the_nether", x: 1, y: 2, z: 3, pitch: 0, yaw: 0 });
  });

  test("rounds coordinates for a compact stored record", () => {
    expect(roundCoordinate(12.3456789)).toBe(12.35);
    expect(roundCoordinate(-0.001)).toBe(-0);
  });
});
