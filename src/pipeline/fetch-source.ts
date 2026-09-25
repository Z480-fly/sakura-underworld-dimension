/**
 * Downloads the existing Underworld world.
 *
 * The world lives in a *different* repository from this add-on:
 * `Z480-fly/unstable-underworld-bedrock`. Nothing here regenerates it - the
 * published `.mcworld` is fetched verbatim, hashed and recorded in
 * `source/SOURCE.json` so the build can prove which revision it consumed.
 *
 * Set `UNDERWORLD_MCWORLD=/path/to/file.mcworld` to use a local copy instead.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { PATHS, SOURCE } from "./config.ts";

const RAW_BASE = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.branch}/${SOURCE.path}`;

export interface SourceManifest {
  repository: string;
  path: string;
  branch: string;
  downloadUrl: string;
  commit: string | null;
  bytes: number;
  sha256: string;
  fetchedAt: string;
  localOverride: string | null;
}

async function resolveCommit(): Promise<string | null> {
  for (const url of [
    `https://api.github.com/repos/${SOURCE.repo}/commits/${SOURCE.branch}`,
    `https://api.github.com/repos/${SOURCE.repo}/commits?sha=${SOURCE.branch}&per_page=1`,
  ]) {
    try {
      const response = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
      if (!response.ok) continue;
      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        const first = payload[0] as { sha?: string } | undefined;
        if (first?.sha) return first.sha;
      } else {
        const sha = (payload as { sha?: string }).sha;
        if (sha) return sha;
      }
    } catch {
      // offline / rate limited - the provenance record simply omits the commit
    }
  }
  return null;
}

function isZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

export async function fetchSourceWorld(): Promise<SourceManifest> {
  await mkdir(PATHS.sourceDir, { recursive: true });

  const override = process.env.UNDERWORLD_MCWORLD;
  if (override) {
    const bytes = await readFile(override);
    if (!isZip(bytes)) throw new Error(`${override} is not a ZIP archive`);
    await writeFile(PATHS.sourceWorld, bytes);
    const manifest: SourceManifest = {
      repository: SOURCE.repo,
      path: SOURCE.path,
      branch: SOURCE.branch,
      downloadUrl: RAW_BASE,
      commit: await resolveCommit(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      fetchedAt: new Date().toISOString(),
      localOverride: override,
    };
    await writeFile(PATHS.sourceManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[source] copied local override ${override} (${fmt(manifest.bytes)})`);
    return manifest;
  }

  const existing = await readManifest();
  if (existing) {
    try {
      const info = await stat(PATHS.sourceWorld);
      const bytes = await readFile(PATHS.sourceWorld);
      if (info.size === existing.bytes && createHash("sha256").update(bytes).digest("hex") === existing.sha256) {
        console.log(`[source] reusing cached ${PATHS.sourceWorld} (${fmt(existing.bytes)})`);
        return existing;
      }
    } catch {
      // fall through to a fresh download
    }
  }

  console.log(`[source] downloading ${RAW_BASE}`);
  const response = await fetch(RAW_BASE);
  if (!response.ok) {
    throw new Error(`could not download the Underworld world: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!isZip(bytes)) throw new Error("the downloaded Underworld world is not a ZIP archive");
  await writeFile(PATHS.sourceWorld, bytes);

  const manifest: SourceManifest = {
    repository: SOURCE.repo,
    path: SOURCE.path,
    branch: SOURCE.branch,
    downloadUrl: RAW_BASE,
    commit: await resolveCommit(),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fetchedAt: new Date().toISOString(),
    localOverride: null,
  };
  await writeFile(PATHS.sourceManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[source] fetched ${fmt(manifest.bytes)} sha256 ${manifest.sha256.slice(0, 16)}...`);
  return manifest;
}

export async function readManifest(): Promise<SourceManifest | undefined> {
  try {
    return JSON.parse(await readFile(PATHS.sourceManifest, "utf8")) as SourceManifest;
  } catch {
    return undefined;
  }
}

function fmt(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

if (import.meta.main) {
  await fetchSourceWorld();
}
