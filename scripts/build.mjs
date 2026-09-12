import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "hunk-gh-review-build-"));
try {
  const metadataPath = join(scratch, "metadata.json");
  execFileSync("bun", [
    "build", "index.tsx", "--target=bun", "--format=esm", "--outfile=dist/index.js",
    "--external", "react", "--external", "@opentui/*", "--external", "hunkdiff/extension",
    "--minify", `--metafile=${metadataPath}`,
  ], { stdio: "inherit" });

  // Preserve the license notices of every dependency included in the bundle.
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const packages = new Map();
  for (const input of Object.keys(metadata.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    let pkg;
    for (;;) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && pkg.version) break;
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`No package metadata for ${input}`);
      directory = parent;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (packages.has(key)) continue;
    const licenseFiles = readdirSync(directory).filter(name => /^licen[sc]e(?:\.|$)/i.test(name)).sort();
    if (!licenseFiles.length) throw new Error(`Missing license notice for ${key}`);
    packages.set(key, licenseFiles.map(name => readFileSync(join(directory, name), "utf8").trim()).join("\n\n"));
  }
  const notices = [...packages].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `${name}\n${"=".repeat(name.length)}\n\n${license}`);
  writeFileSync("dist/THIRD_PARTY_LICENSES.txt", notices.join("\n\n") + "\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
