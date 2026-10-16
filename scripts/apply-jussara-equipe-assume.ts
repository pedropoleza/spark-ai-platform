/**
 * Jussara (pGl5pqLLG0QDixANpFnP) — ticket #445, 2026-10-16: liga o modo
 * "equipe falou, a IA não entra" (H105, `agent_configs.skip_if_team_contacted`).
 *
 * Pedido literal (Jussara no grupo de suporte, 16/10): "As mensagens com IA é
 * somente quando o patrocinado chega, depois que tem interação humana ela tem
 * que parar de falar" e "ficou acordado que ela não iria mais entrar em
 * conversas que já teria tido interação nossa". Ticket: "Configurar a IA apenas
 * para iniciar e não seguir conversa".
 *
 * Com o modo ligado, qualquer contato da equipe no histórico (mensagem pelo
 * celular, inbox ou Spark OS, ou ligação) tira a IA da conversa, inclusive antes
 * de ela falar. Replay em 16/10: equipe presente em 73 das 86 conversas ativas
 * da IA nos últimos 30 dias (scripts/_replay-h105.ts).
 *
 * E no prompt do follow-up: o toque de 16/10 ofereceu "posso te mandar uma
 * cotação hoje?", e a conta não manda cotação por mensagem ("não mandamos
 * cotação pra nenhum cliente"; a simulação é mostrada na reunião, como o prompt
 * principal já diz). O prompt do follow-up só proibia citar valor.
 *
 * Idempotente. Revert: --revert (volta pra false e tira a linha do follow-up).
 * Rodar: npx tsx scripts/apply-jussara-equipe-assume.ts [--apply|--revert]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const AGENT = "a297dadc-873a-4803-885d-472c65414168"; // Jussara Lima — Vendas
const APLICAR = process.argv.includes("--apply");
const LINHA_COTACAO =
  "NUNCA ofereça mandar cotação, simulação ou proposta por mensagem (nada de 'posso te mandar uma cotação'): a conta não envia cotação por aqui, ela é apresentada só na reunião com a Jussara.";
const REVERTER = process.argv.includes("--revert");

async function main() {
  const sb = createAdminClient();
  const { data: antes, error } = await sb
    .from("agent_configs")
    .select("agent_id, skip_if_team_contacted, auto_pause_on_human_message, updated_at")
    .eq("agent_id", AGENT)
    .single();
  if (error) throw error;
  console.log("antes:", antes);
  if (!APLICAR && !REVERTER) {
    console.log("(dry-run; use --apply ou --revert)");
    process.exit(0);
  }
  const valor = APLICAR && !REVERTER;
  const { data: fuRow } = await sb.from("agent_configs").select("follow_up_config").eq("agent_id", AGENT).single();
  const fu = { ...((fuRow?.follow_up_config as Record<string, unknown>) || {}) };
  const prompt = String(fu.custom_prompt || "");
  if (valor && !prompt.includes(LINHA_COTACAO)) fu.custom_prompt = `${prompt.trim()} ${LINHA_COTACAO}`.trim();
  if (!valor && prompt.includes(LINHA_COTACAO)) fu.custom_prompt = prompt.replace(` ${LINHA_COTACAO}`, "").replace(LINHA_COTACAO, "").trim();
  const { error: upErr } = await sb
    .from("agent_configs")
    .update({ skip_if_team_contacted: valor, follow_up_config: fu, updated_at: new Date().toISOString() })
    .eq("agent_id", AGENT);
  if (upErr) throw upErr;
  const { data: depois } = await sb
    .from("agent_configs")
    .select("agent_id, skip_if_team_contacted, auto_pause_on_human_message, updated_at")
    .eq("agent_id", AGENT)
    .single();
  console.log("depois:", depois);
  const { data: fuDepois } = await sb.from("agent_configs").select("follow_up_config").eq("agent_id", AGENT).single();
  console.log("follow-up prompt:", (fuDepois?.follow_up_config as { custom_prompt?: string })?.custom_prompt);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
