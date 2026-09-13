import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");
const packs = [
  { name: "autonomous_ai_bot_behavior", alias: "AI-Bot-Behavior", directory: join(root, "behavior_packs", "autonomous_ai_bot") },
  { name: "autonomous_ai_bot_resources", alias: "AI-Bot-Resources", directory: join(root, "resource_packs", "autonomous_ai_bot") }
];

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function validatePack(pack) {
  const manifestPath = join(pack.directory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  for (const path of files(pack.directory).filter((value) => value.endsWith(".json"))) json(path);
  const manifest = json(manifestPath);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (manifest.format_version !== 2 || !uuid.test(manifest.header?.uuid || "") || !Array.isArray(manifest.header?.version) || !Array.isArray(manifest.header?.min_engine_version)) throw new Error(`Invalid header in ${manifestPath}`);
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) throw new Error(`No modules in ${manifestPath}`);
  for (const module of manifest.modules) {
    if (!uuid.test(module.uuid || "")) throw new Error(`Invalid module UUID ${module.uuid} in ${manifestPath}`);
    if (module.type === "script" && !existsSync(join(pack.directory, module.entry || ""))) throw new Error(`Missing script entry ${module.entry}`);
  }
  if (!existsSync(join(pack.directory, "pack_icon.png"))) throw new Error(`Missing pack_icon.png in ${pack.directory}`);
  return manifest;
}

// Bedrock parses entity JSON with a *content* format_version, which is NOT the
// same numbering as the game/engine version. Anything the parser does not know
// (for example "1.26.40") makes it drop the whole definition — the scripts still
// load, but `aibot:companion` never becomes a registered entity type and every
// spawn fails with "'aibot:companion' is not a valid entity type". These are the
// highest format versions Mojang actually ships in bedrock-samples.
const MAX_BEHAVIOR_ENTITY_FORMAT = [1, 21, 50];
const MAX_CLIENT_ENTITY_FORMAT = [1, 10, 0];

function parseFormatVersion(value, path) {
  const parts = String(value || "").split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) throw new Error(`Invalid format_version "${value}" in ${path}`);
  return parts;
}

function assertFormatVersionAtMost(path, key, maximum) {
  const data = json(path);
  if (!(key in data)) return;
  const actual = parseFormatVersion(data.format_version, path);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] < maximum[index]) return;
    if (actual[index] > maximum[index]) {
      throw new Error(
        `${path} declares format_version ${actual.join(".")}, which Bedrock cannot parse ` +
        `(maximum supported for ${key} is ${maximum.join(".")}). The entity would silently ` +
        `not be registered and /aibot:create would fail with "not a valid entity type".`
      );
    }
  }
}

function validateEntityFormats() {
  for (const path of files(join(root, "behavior_packs")).filter((value) => value.endsWith(".json"))) {
    assertFormatVersionAtMost(path, "minecraft:entity", MAX_BEHAVIOR_ENTITY_FORMAT);
  }
  for (const path of files(join(root, "resource_packs")).filter((value) => value.endsWith(".json"))) {
    assertFormatVersionAtMost(path, "minecraft:client_entity", MAX_CLIENT_ENTITY_FORMAT);
  }
}

function packagePack(pack) {
  const destination = join(output, `${pack.name}.mcpack`);
  // zip is available on the Ubuntu runner and keeps the resulting .mcpack
  // compatible with Android/iOS/Windows Minecraft import. The working
  // directory ensures manifest.json is at the archive root.
  execFileSync("zip", ["-q", "-r", "-X", destination, ".", "-x", "*.DS_Store", "*__MACOSX*"], {
    cwd: pack.directory,
    stdio: "inherit"
  });
  const alias = join(output, `${pack.alias}.mcpack`);
  copyFileSync(destination, alias);
  return { destination, alias };
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const manifests = packs.map(validatePack);
validateEntityFormats();
const allUuids = manifests.flatMap((manifest) => [manifest.header.uuid, ...manifest.modules.map((module) => module.uuid)]);
if (new Set(allUuids).size !== allUuids.length) throw new Error("Duplicate pack/module UUID detected.");
const [behaviorManifest, resourceManifest] = manifests;
const resourceDependency = behaviorManifest.dependencies?.find((dependency) => dependency.uuid === resourceManifest.header.uuid);
if (!resourceDependency || JSON.stringify(resourceDependency.version) !== JSON.stringify(resourceManifest.header.version)) throw new Error("Behavior pack must depend on the exact resource-pack UUID/version.");
const packaged = packs.map(packagePack);
const artifacts = packaged.flatMap((pack) => [pack.destination, pack.alias]);
const addon = join(output, "autonomous_ai_bot.mcaddon");
const mobileAddon = join(output, "AI-Bot-Bedrock-Mobile.mcaddon");
const latestAddon = join(output, "Minecraft-Bot-Latest.mcaddon");
execFileSync("zip", ["-q", "-X", addon, ...packaged.map((pack) => pack.destination.split(/[\\/]/).pop())], {
  cwd: output,
  stdio: "inherit"
});
copyFileSync(addon, mobileAddon);
copyFileSync(addon, latestAddon);
artifacts.push(addon, mobileAddon, latestAddon);
const buildInfo = {
  version: manifests[0].header.version.join("."),
  generatedAt: new Date().toISOString(),
  target: "Minecraft Bedrock / Pocket Edition / Android / iOS 26.40+",
  scriptModules: { "@minecraft/server": "2.9.0", "@minecraft/server-ui": "2.1.0" },
  experimentsRequired: false,
  install: "Open AI-Bot-Bedrock-Mobile.mcaddon on a phone or desktop, then activate both packs in the world.",
  artifacts: artifacts.map((path) => path.replace(`${root}/`, ""))
};
writeFileSync(join(output, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`Created ${artifacts.length} Minecraft packs in ${output}`);
for (const artifact of artifacts) console.log(`- ${artifact}`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  writeFileSync(summary, [
    "## Bedrock / mobile mod pack",
    "",
    "Import **`AI-Bot-Bedrock-Mobile.mcaddon`** on Android, iOS or Windows Bedrock.",
    "Separate `.mcpack` files are also attached if you need to import behavior and resources one at a time.",
    "",
    "| File | Use |",
    "|---|---|",
    "| `AI-Bot-Bedrock-Mobile.mcaddon` | One-tap install on phone and Bedrock |",
    "| `AI-Bot-Behavior.mcpack` | Behavior pack only |",
    "| `AI-Bot-Resources.mcpack` | Resource pack only |",
    "",
    `Version **${buildInfo.version}** · target **${buildInfo.target}**`,
    ""
  ].join("\n"), { flag: "a" });
}
