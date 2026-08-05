/**
 * One-off (Pedro autorizou 2026-06-22 "vai faz tudo"): destrava a conversa da
 * Manuela Garcia (+19544771397). O bot ficou MUDO pra ela desde 16:46 de 06-22:
 * ela pediu pra criar 14 reuniões de uma vez no Calendário - Carreira (da Ana Paula)
 * → o turno estourou o maxDuration (60s) no meio das criações → lambda morta =
 * silêncio total, e cada msg nova reativava o loop. Fix anti-timeout já está em prod
 * (orçamento de wall-clock no loop do agente). Esta mensagem quebra o silêncio +
 * reorienta pra um caminho que funciona (lotes menores / calendário certo).
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/resume-manuela.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+19544771397";

const MSG =
  "Oi Manuela! 🙏 Desculpa o sumiço — eu travei aqui tentando criar as *14 reuniões de uma vez* " +
  "no Calendário - Carreira. Já consertei do meu lado e tô de volta. 🙌\n\n" +
  "Pra dar certo de verdade, tem um detalhe que eu já tinha comentado: o *Calendário - Carreira* é " +
  "da *Ana Paula*, e eu só consigo criar reunião num calendário onde você participa. Duas saídas:\n\n" +
  "*1.* Se a Ana Paula já te adicionou como membro desse calendário, me responde *\"já me adicionou\"* " +
  "que eu tento de novo — agora em *lotes menores* (uns dias por vez) pra não travar.\n" +
  "*2.* Se preferir, eu já crio as reuniões no *seu* calendário agora — é só falar.\n\n" +
  "Como você quer seguir? 👇";

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name")
    .eq("phone", PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep não encontrada: " + PHONE);

  console.log(`→ ${rep.display_name} (${rep.phone}) loc=${rep.active_location_id}`);
  console.log(`mensagem (${MSG.length} chars):\n---\n${MSG}\n---`);

  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    MSG,
    {
      activeLocationId: rep.active_location_id,
      source: "manual_recovery",
      kind: "manual_recovery",
      extraMetadata: {
        reason: "silent_timeout_14_appointments",
        incident: "2026-06-22",
        by: "pedro_authorized_2026-06-22",
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
