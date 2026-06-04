/**
 * One-off (Pedro autorizou 2026-06-04): manda retomada pros 2 reps travados em
 * loop verbatim (Sieder Madrona, Soraia Close) após o fix F57. Honesto sobre o
 * errinho, retoma de onde parou, devolve a palavra pro rep. Quando eles
 * responderem, o F57 já pega o fluxo natural.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/send-recovery-sieder-soraia.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const SIEDER_ID = "3cc60d99-36dd-4e09-a507-bb5d1b09eeef";
const SORAIA_ID = "1fae9c35-6c69-4757-89a7-2c459ace8772";

const MSG_SIEDER =
  "Opa Sieder! Tô de volta 🙌 Tive um errinho técnico aqui que me deixou repetindo a mesma mensagem, e já foi corrigido de vez. Foi mal por isso!\n\n" +
  "Vi teu \"bora começar\" 👊 Então vamos: me diz qual lead ou tarefa você quer atacar primeiro pra manter aquecido, ou se prefere que eu já te mostre quem tá parado no funil precisando de follow-up. Você escolhe e eu começo.";

const MSG_SORAIA =
  "Oi Soraia! Desculpa o errinho técnico aqui, eu fiquei repetindo a mesma mensagem de confirmação. Já corrigi. 🙏\n\n" +
  "Deixa eu esclarecer pra gente destravar: quando você confirma, eu marco a reunião com o Thad Gourley (seg 08/06 às 3:00 PM) na SUA agenda. Se você também quer que eu DISPARE uma mensagem de confirmação pro próprio Thad, é só me pedir que eu mando.\n\n" +
  "Quer que eu confirme a reunião? E aí: só agendo, ou agendo e mando a mensagem pro Thad também?";

async function main() {
  const supabase = createAdminClient();
  const { data: reps, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name")
    .in("id", [SIEDER_ID, SORAIA_ID]);
  if (error) throw new Error(error.message);

  const byId = new Map((reps || []).map((r) => [r.id, r]));
  const plan = [
    { rep: byId.get(SIEDER_ID), msg: MSG_SIEDER },
    { rep: byId.get(SORAIA_ID), msg: MSG_SORAIA },
  ];

  for (const { rep, msg } of plan) {
    if (!rep) {
      console.log("rep não encontrado, pulando");
      continue;
    }
    console.log(`\n→ ${rep.display_name} (${rep.phone}) loc=${rep.active_location_id}`);
    console.log(`   "${msg.slice(0, 70)}..."`);
    const res = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
      msg,
      {
        activeLocationId: rep.active_location_id,
        source: "manual_recovery_f57",
        kind: "recovery",
        extraMetadata: { reason: "loop_verbatim_recovery", by: "pedro_authorized_2026-06-04" },
      },
    );
    console.log(`   resultado: ${JSON.stringify(res)}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
