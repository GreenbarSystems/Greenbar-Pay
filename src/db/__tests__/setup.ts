// dotenv-style load without an extra dependency; .env then .env.test.
import { readFileSync, existsSync } from "node:fs";

for (const file of [".env", ".env.test"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) {
      process.env[k] = v.replace(/^"(.*)"$/, "$1");
    }
  }
}
