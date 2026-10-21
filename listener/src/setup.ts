// Writes each sender's run folder: settings.json from config (src/settings.ts) and, when it is not
// there yet, system_prompt.md from run_template/. Run once after cloning: `bun run setup`.
// runs/ is gitignored, because in use it also holds the code-made copies of household data.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SENDERS } from "./config";
import { runSettings } from "./settings";

for (const s of SENDERS) {
  mkdirSync(s.runDir, { recursive: true });
  writeFileSync(join(s.runDir, "settings.json"), JSON.stringify(runSettings(s), null, 2) + "\n");
  const prompt = join(s.runDir, "system_prompt.md");
  if (!existsSync(prompt)) copyFileSync(join(ROOT, "run_template", `system_prompt.${s.key}.md`), prompt);
  console.log(`${s.key}: ${s.runDir}`);
}
