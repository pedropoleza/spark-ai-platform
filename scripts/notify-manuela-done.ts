/**
 * One-off (Pedro 2026-06-23): avisa a Manuela que as 14 reuniões foram criadas
 * (finalizei via override admin — ver finalize-manuela-appointments.ts).
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/notify-manuela-done.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+19544771397";

const MSG =
  "Prontinho, Manuela! ✅ Criei as *14 reuniões* no *Calendário - Carreira* da Ana Paula, 30min cada, " +
  "atribuídas a ela:\n\n" +
  "*Segunda 29/06:*\n" +
  "• 14:00 Guilherme Lucchese\n" +
  "• 14:30 Matthew Vaughn\n" +
  "• 15:00 Lidiane Borges\n" +
  "• 16:00 Bianca Soares\n" +
  "• 16:30 Onofre Arruda\n" +
  "• 17:00 John\n" +
  "• 18:30 Bruna Olson\n" +
  "• 19:00 Tullio Ferraz\n" +
  "• 19:30 William\n\n" +
  "*Terça 01/07:*\n" +
  "• 16:30 Marcos\n" +
  "• 17:00 Cleonice\n" +
  "• 17:30 Karla\n" +
  "• 18:00 Diogo\n" +
  "• 18:30 Marlucia\n\n" +
  "Tá tudo na agenda da Ana Paula 🙌 Os intervalos (seg 15:30–16h e 17:30–18:30) ficaram livres, como você pediu.\n\n" +
  "Sobre ser *toda semana*: por enquanto eu não repito sozinho — quando chegar perto da próxima semana, é só me mandar *\"repete as reuniões\"* que eu crio de novo. 😉";

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name")
    .eq("phone", PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep não encontrada: " + PHONE);

  console.log(`→ ${rep.display_name} (${rep.phone})`);
  console.log(`mensagem (${MSG.length} chars)`);

  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    MSG,
    {
      activeLocationId: rep.active_location_id,
      source: "manual_recovery",
      kind: "manual_recovery",
      extraMetadata: { reason: "14_appointments_created", by: "pedro_authorized_2026-06-23" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
