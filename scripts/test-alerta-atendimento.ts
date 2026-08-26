/**
 * H83 — aviso por WhatsApp quando o atendimento trava.
 *
 * Cobre a leitura de config (o gate que decide se alguém é avisado) e a
 * sobrevivência do campo ao zod — que é onde configs deste projeto morrem:
 * `z.object()` estripa chave desconhecida e a rota persiste o body VALIDADO,
 * exatamente como o `require_contact_before_booking` sumia (H72).
 *
 *   npx tsx scripts/test-alerta-atendimento.ts
 */
import { lerConfigAlerta } from "@/lib/queue/alerta-atendimento";
import { updateAgentConfigSchema } from "@/lib/utils/validation";

let fail = 0;
const check = (nome: string, ok: boolean, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${nome}${extra ? ` — ${extra}` : ""}`);
};

console.log("=== leitura da config ===");
const ligado = { notifications: { alerta_whatsapp: { enabled: true, phone: "+17549715189" } } };
check("config ligada é lida", lerConfigAlerta(ligado)?.phone === "+17549715189");
check("enabled:false → desligado", lerConfigAlerta({ notifications: { alerta_whatsapp: { enabled: false, phone: "+1" } } }) === null);
check("sem enabled → desligado (opt-in explícito)", lerConfigAlerta({ notifications: { alerta_whatsapp: { phone: "+1" } } }) === null);
check("sem o bloco → desligado", lerConfigAlerta({ notifications: { on_error: true } }) === null);
check("notifications ausente → desligado", lerConfigAlerta({}) === null);
check("config null → desligado", lerConfigAlerta(null) === null);
check("config undefined → desligado", lerConfigAlerta(undefined) === null);
check("frota intacta: agente sem a chave nunca alerta", lerConfigAlerta({ notifications: { on_qualified: true, on_booked: true, on_handed_off: false, on_error: true, notification_email: "" } }) === null);

console.log("\n=== sobrevivência ao zod (a armadilha do H72) ===");
const corpo = {
  notifications: {
    on_qualified: true, on_booked: true, on_handed_off: false, on_error: true, notification_email: "",
    alerta_whatsapp: { enabled: true, phone: "+17549715189", motivos: ["turno_falhou", "ia_pausada"] },
  },
};
const parsed = updateAgentConfigSchema.safeParse(corpo);
check("o PUT valida", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 160));
if (parsed.success) {
  const saiu = (parsed.data.notifications as { alerta_whatsapp?: { phone?: string; enabled?: boolean; motivos?: string[] } })?.alerta_whatsapp;
  check("alerta_whatsapp SOBREVIVE (não é estripado)", !!saiu, saiu ? `phone=${saiu.phone}` : "SUMIU");
  check("telefone preservado", saiu?.phone === "+17549715189");
  check("motivos preservados", JSON.stringify(saiu?.motivos) === JSON.stringify(["turno_falhou", "ia_pausada"]));
  // O que é lido do banco depois do save tem que continuar ligando o alerta.
  check("round-trip: o que sai do zod ainda liga o alerta", lerConfigAlerta(parsed.data)?.enabled === true);
}
const motivoInvalido = updateAgentConfigSchema.safeParse({
  notifications: { alerta_whatsapp: { enabled: true, phone: "+1", motivos: ["explodiu"] } },
});
check("motivo inválido é rejeitado", !motivoInvalido.success);

const total = 14;
console.log(fail === 0 ? `\n✅ ${total}/${total}` : `\n❌ ${fail} falha(s) de ${total}`);
process.exit(fail === 0 ? 0 : 1);
