import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const supportedPlatforms = new Set(["darwin", "linux"]);

if (!supportedPlatforms.has(process.platform)) {
  process.exit(0);
}

const requireFromHere = createRequire(path.join(process.cwd(), "scripts/postinstall.js"));

function fail(message) {
  throw new Error(`pi-generative-ui Glimpse verification failed.\n\n${message}`);
}

function resolvePackageRoot() {
  try {
    const entryPath = requireFromHere.resolve("glimpseui");
    return path.dirname(path.dirname(entryPath));
  } catch {
    return null;
  }
}

const glimpsePackageRoot = resolvePackageRoot();
if (!glimpsePackageRoot) {
  fail(
    [
      "The upstream 'glimpseui' runtime dependency was not installed for this package.",
      "Run npm install again and confirm the optional dependency is available for the current platform.",
      "Linux support now depends on upstream Glimpse instead of the repo-local helper.",
    ].join("\n"),
  );
}

const glimpsePackageJsonPath = path.join(glimpsePackageRoot, "package.json");
const glimpsePackage = JSON.parse(fs.readFileSync(glimpsePackageJsonPath, "utf8"));
const skippedBuildPath = path.join(glimpsePackageRoot, ".glimpse-build-skipped");
const skippedBuild = fs.existsSync(skippedBuildPath)
  ? fs.readFileSync(skippedBuildPath, "utf8").trim()
  : null;

process.stdout.write(`Using Glimpse runtime dependency: ${glimpsePackage.name}@${glimpsePackage.version}\n`);
if (skippedBuild) {
  process.stdout.write(`[glimpse] ${skippedBuild}\n`);
}
