// Dispara notif de completion pra 1 job manualmente
// Uso: JOB_ID=xxx npx tsx -r tsconfig-paths/register scripts/notify-job-completed-manual.ts
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { notifyRepJobCompleted } from "@/lib/account-assistant/proactive/bulk-completion-notifier";

async function main() {
  const jobId = process.env.JOB_ID || process.argv[2];
  if (!jobId) {
    console.error("Faltou JOB_ID");
    process.exit(1);
  }
  console.log(`\nNotificando completion do job ${jobId}...\n`);
  const r = await notifyRepJobCompleted(jobId);
  console.log(JSON.stringify(r, null, 2));
}
main();
