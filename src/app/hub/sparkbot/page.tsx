import { SparkbotConfigView } from "./sparkbot-config-view";

// Tela dedicada de config do SparkBot (Pedro 2026-06-09). Auth + shell vêm do
// HubLayout (HubShell); a view busca /api/hub/sparkbot-config (getSession).
export const dynamic = "force-dynamic";

export default function SparkbotConfigPage() {
  return <SparkbotConfigView />;
}
