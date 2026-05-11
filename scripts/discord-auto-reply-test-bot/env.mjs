import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const dotenvPath = path.join(repoRoot, ".env");
const dotenvValues = loadRepoDotenv();

export function readDiscordEnv(name, aliases = []) {
  const names = [name, ...aliases];
  for (const key of names) {
    const value = dotenvValues[key]?.trim();
    if (value) {
      return value;
    }
  }
  for (const key of names) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function loadRepoDotenv() {
  try {
    if (!fs.existsSync(dotenvPath)) {
      return {};
    }
    return dotenv.parse(fs.readFileSync(dotenvPath, "utf8"));
  } catch {
    console.error("Could not load repo .env for Discord test bot settings.");
    process.exit(1);
  }
}
