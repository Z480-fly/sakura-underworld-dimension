import { describe, expect, test } from "bun:test";
import type { BlockStateEntry } from "../mcworld/subchunk.ts";
import { GRAVITY_BLOCKS, GRAVITY_BLOCK_REPLACEMENTS, remapEntry, replacementFor, replacementNames } from "./remap.ts";

const gravel: BlockStateEntry = { name: "minecraft:gravel", states: new Map(), version: 18163713 };

describe("falling block remap", () => {
  test("swaps gravel for black glass and leaves everything else alone", () => {
    expect(replacementFor("minecraft:deepslate", 1, 2, 3)).toBeUndefined();
    expect(remapEntry(gravel, 1, 2, 3)).not.toBe(gravel);
    expect(replacementNames("minecraft:gravel")).toEqual([
      "minecraft:black_stained_glass",
      "minecraft:tinted_glass",
    ]);
    const deepslate: BlockStateEntry = { name: "minecraft:deepslate", states: new Map(), version: 0 };
    expect(remapEntry(deepslate, 1, 2, 3)).toBe(deepslate);
  });

  test("picks the same replacement for the same position", () => {
    const first = remapEntry(gravel, -123.0, 43, 148);
    const second = remapEntry(gravel, -123, 43, 148);
    expect(first.name).toBe(second.name);
    expect(replacementNames("minecraft:gravel")).toContain(first.name);
  });

  test("mixes both glass blocks over a volume rather than picking one", () => {
    const names = new Set<string>();
    for (let x = 0; x < 32; x++) {
      for (let y = 0; y < 32; y++) {
        for (let z = 0; z < 32; z++) names.add(remapEntry(gravel, x, y, z).name);
      }
    }
    expect([...names].sort()).toEqual(["minecraft:black_stained_glass", "minecraft:tinted_glass"]);
  });

  test("drops the source block's states, which the replacement does not share", () => {
    const powered: BlockStateEntry = {
      name: "minecraft:gravel",
      states: new Map([["some_state", { type: 1, value: 1 }]]),
      version: 42,
    };
    const remapped = remapEntry(powered, 4, 5, 6);
    expect(remapped.states.size).toBe(0);
    expect(remapped.version).toBe(42);
  });

  test("covers every gravity block the verifier refuses to package", () => {
    for (const name of GRAVITY_BLOCKS) {
      expect(GRAVITY_BLOCK_REPLACEMENTS[name]?.length).toBeGreaterThan(0);
      expect(GRAVITY_BLOCKS).not.toContain(GRAVITY_BLOCK_REPLACEMENTS[name]![0]!.name);
    }
  });
});
