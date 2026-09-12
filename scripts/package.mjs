import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function validatePack(pack) {
  const manifestPath = join(pack.directory, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifest = json(manifestPath);
  if (!manifest.header?.uuid || !Array.isArray(manifest.header?.version)) throw new Error(`Invalid header in ${manifestPath}`);
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) throw new Error(`No modules in ${manifestPath}`);
  if (!existsSync(join(pack.directory, "pack_icon.png"))) throw new Error(`Missing pack_icon.png in ${pack.directory}`);
  return manifest;
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
const packaged = packs.map(packagePack);
const artifacts = packaged.flatMap((pack) => [pack.destination, pack.alias]);
const addon = join(output, "autonomous_ai_bot.mcaddon");
const mobileAddon = join(output, "AI-Bot-Bedrock-Mobile.mcaddon");
execFileSync("zip", ["-q", "-X", addon, ...packaged.map((pack) => pack.destination.split(/[\\/]/).pop())], {
  cwd: output,
  stdio: "inherit"
});
copyFileSync(addon, mobileAddon);
artifacts.push(addon, mobileAddon);
const buildInfo = {
  version: manifests[0].header.version.join("."),
  generatedAt: new Date().toISOString(),
  target: "Bedrock / Pocket Edition / Android / iOS 1.26.0+",
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
