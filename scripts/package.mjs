import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const packs = [
  { name: "autonomous_ai_bot_behavior", directory: join(root, "behavior_packs", "autonomous_ai_bot") },
  { name: "autonomous_ai_bot_resources", directory: join(root, "resource_packs", "autonomous_ai_bot") }
];

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validatePack(pack) {
  const manifestPath = join(pack.directory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifest = json(manifestPath);
  if (!manifest.header?.uuid || !Array.isArray(manifest.header?.version)) throw new Error(`Invalid header in ${manifestPath}`);
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) throw new Error(`No modules in ${manifestPath}`);
  return manifest;
}

function packagePack(pack) {
  const destination = join(output, `${pack.name}.mcpack`);
  // zip is available on the Ubuntu runner and keeps the resulting .mcpack
  // compatible with Android/Minecraft import. The working directory ensures
  // manifest.json is at the archive root.
  execFileSync("zip", ["-q", "-r", destination, "."], { cwd: pack.directory, stdio: "inherit" });
  return destination;
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const manifests = packs.map(validatePack);
const artifacts = packs.map(packagePack);
const addon = join(output, "autonomous_ai_bot.mcaddon");
execFileSync("zip", ["-q", addon, ...artifacts.map((path) => path.split(/[\\/]/).pop())], { cwd: output, stdio: "inherit" });
artifacts.push(addon);
const buildInfo = {
  version: manifests[0].header.version.join("."),
  generatedAt: new Date().toISOString(),
  target: "Bedrock 1.26.0+",
  artifacts: artifacts.map((path) => path.replace(`${root}/`, ""))
};
writeFileSync(join(output, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`Created ${artifacts.length} Minecraft packs in ${output}`);
for (const artifact of artifacts) console.log(`- ${artifact}`);
