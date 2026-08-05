/**
 * One-off (Pedro autorizou 2026-06-19): reenvia os Termos + retoma a conversa com
 * a Jussara (rep +16892033343). O envio dos termos tinha travado porque ela escreveu
 * de um número que não batia com o GHL user dela (estava cadastrada com outro) →
 * identifyRep não a reconheceu → termos nunca dispararam. Pedro corrigiu o GHL user
 * e o phone da rep foi atualizado pro 689. Esta mensagem reapresenta os termos +
 * sinaliza que vamos ponto a ponto, já citando o contexto que ela mandou.
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/resume-jussara.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";
import { TERMS_OF_USE_TEXT } from "../src/lib/account-assistant/terms";

const PHONE = "+16892033343";

const PREAMBLE =
  "Oi Jussara! 👋 Aqui é o *SparkBot*. Desculpa o sumiço — teve um probleminha técnico " +
  "no seu cadastro (seu número estava registrado diferente) e por isso eu não consegui te " +
  "responder antes. Já tá resolvido e eu tô de volta. 🙌\n\n" +
  "Antes da gente começar, preciso só do seu *ok* rapidinho:";

const CLOSER =
  "\n\nPra liberar, é só responder *aceito* 👍\n\n" +
  "Assim que você topar, a gente vai *ponto por ponto* ver o que você precisa. Já vi que você " +
  "me mandou o contato da *Elizangela — (508) 740-9145* e um *modelo de mensagem de follow-up* " +
  '("Mensagem 1 – 30 minutos após a call perdida") — tá tudo guardado aqui, a gente organiza juntos. 🚀';

const MSG = `${PREAMBLE}\n\n${TERMS_OF_USE_TEXT}${CLOSER}`;

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name, terms_accepted_at")
    .eq("phone", PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep não encontrada: " + PHONE);
  if (rep.terms_accepted_at) {
    console.log("⚠️ rep JÁ aceitou os termos — abortando reenvio.");
    process.exit(0);
  }

  console.log(`→ ${rep.display_name} (${rep.phone}) loc=${rep.active_location_id}`);
  console.log(`mensagem (${MSG.length} chars):\n---\n${MSG}\n---`);

  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    MSG,
    {
      activeLocationId: rep.active_location_id,
      source: "manual_recovery",
      kind: "terms_resend",
      extraMetadata: {
        reason: "terms_never_sent_phone_mismatch",
        old_phone: "+13212768361",
        by: "pedro_authorized_2026-06-19",
      },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
