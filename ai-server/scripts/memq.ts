import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
  const { listMemories } = await import("../src/lib/db/memories");
  const rows = await listMemories();
  console.log(`${rows.length} memories:`);
  for (const m of rows) {
    console.log(`  [${m.id.slice(0, 8)}] ${m.device_id ? "device" : "global"}  ${m.enabled ? "on " : "off"}  ${m.content}  (${m.tags.join(",")})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
