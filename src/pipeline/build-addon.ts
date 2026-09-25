/**
 * Assembles the final `.mcaddon`.
 *
 * A `.mcaddon` is a ZIP whose root holds one folder per pack. Each folder gets
 * a manifest, the static files from `src/addon/`, the extracted structure tiles
 * and the compiled behavior-pack script.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ZipWriter } from "../mcutil/zip.ts";
import { ADDON, PATHS } from "./config.ts";

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

async function compileRuntimeScript(): Promise<void> {
  const result = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.runtime.json"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`the behavior pack script failed to compile (tsc exit code ${result.exitCode})`);
  }
  const compiled = join(PATHS.behaviorPack, ADDON.scriptEntry);
  await stat(compiled);
}

export async function assembleAddon(): Promise<void> {
  await rm(PATHS.addonDir, { recursive: true, force: true });
  await mkdir(PATHS.addonDir, { recursive: true });

  await cp(PATHS.staticBehaviorPack, PATHS.behaviorPack, { recursive: true });
  await cp(PATHS.staticResourcePack, PATHS.resourcePack, { recursive: true });
  await cp(PATHS.structuresDir, join(PATHS.behaviorPack, ADDON.structureFolder), { recursive: true });

  await compileRuntimeScript();

  const files = await listFiles(PATHS.addonDir);
  const zip = new ZipWriter();
  for (const file of files.sort()) {
    const name = relative(PATHS.addonDir, file).split(sep).join("/");
    zip.addFile(name, await readFile(file));
  }
  const archive = zip.finish();
  await mkdir(PATHS.dist, { recursive: true });
  await writeFile(PATHS.addon, archive);
  console.log(
    `[assemble] ${PATHS.addon} - ${files.length} files, ${(archive.length / 1024 / 1024).toFixed(2)} MB`,
  );
}
