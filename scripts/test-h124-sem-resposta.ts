/**
 * H124: evento "no_reply_after_followups" só no toque terminal sem resposta, e o
 * Salvar do painel preserva disqualify_after_final e a automação desse evento.
 * Rodar: npx tsx scripts/test-h124-sem-resposta.ts
 */
import { isFinalNoReplyEvent, NO_REPLY_AFTER_FOLLOWUPS_EVENT } from "@/lib/queue/follow-up-scheduler";
import { makeSeed, buildConfigPayload } from "@/app/hub/agents/[agentId]/config-payload";
import { updateAgentConfigSchema } from "@/lib/utils/validation";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };

ok("o evento novo tem o nome combinado", NO_REPLY_AFTER_FOLLOWUPS_EVENT === "no_reply_after_followups");
ok("toque terminal dispara o evento novo", isFinalNoReplyEvent("no_reply_after_followups"));
ok("toque terminal segue disparando 'disqualified' (compatível)", isFinalNoReplyEvent("disqualified"));
ok("'qualified' não dispara no toque terminal", !isFinalNoReplyEvent("qualified"));
ok("evento vazio não dispara", !isFinalNoReplyEvent(undefined));

// O turno da IA dispara automações cujo evento é igual ao status final; o status nunca vale o evento novo.
const statusDoTurno = ["active", "qualified", "booked", "stale", "handed_off", "disqualified"];
ok("nenhum status do turno da IA casa com o evento novo", !statusDoTurno.includes(NO_REPLY_AFTER_FOLLOWUPS_EVENT));

const regra = {
  id: "fu-sem-resposta-video",
  trigger: { kind: "event", event: NO_REPLY_AFTER_FOLLOWUPS_EVENT, event_label: "Sem resposta aos follow-ups" },
  actions: [{ type: "create_opportunity", pipeline_id: "P1", stage_id: "S-followup", opportunity_name: "Novo lead" }],
};
const linha = {
  follow_up_config: {
    enabled: true, mode: "manual", intensity: 2, max_attempts: 3, min_delay_minutes: 60, max_delay_minutes: 10080,
    custom_prompt: "curto", manual_steps: [{ delay_minutes: 60 }, { delay_minutes: 1440 }, { delay_minutes: 4320 }],
    start_on_entry: true, disqualify_after_final: true,
  },
  automations: [regra],
};
const payload = buildConfigPayload(makeSeed(linha), new Set()) as Record<string, unknown>;
const parsed = updateAgentConfigSchema.safeParse(payload);
ok("o payload do painel passa no zod", parsed.success, parsed.success ? undefined : parsed.error.issues.slice(0, 3));
const fu = (parsed.success ? (parsed.data as Record<string, unknown>).follow_up_config : null) as Record<string, unknown> | null;
ok("Salvar preserva disqualify_after_final", fu?.disqualify_after_final === true, fu);
ok("Salvar segue preservando start_on_entry", fu?.start_on_entry === true, fu);
const autos = (parsed.success ? (parsed.data as Record<string, unknown>).automations : null) as Array<Record<string, any>> | null;
const salva = autos?.find((a) => a.id === regra.id);
ok("Salvar preserva a automação do evento novo", salva?.trigger?.event === NO_REPLY_AFTER_FOLLOWUPS_EVENT, autos);
ok("Salvar preserva a ação de mover pra etapa", salva?.actions?.[0]?.type === "create_opportunity" && salva?.actions?.[0]?.stage_id === "S-followup", salva);

const semFlag = buildConfigPayload(makeSeed({ follow_up_config: { ...linha.follow_up_config, disqualify_after_final: undefined } }), new Set()) as Record<string, any>;
ok("sem a opção ligada, o payload não inventa a chave", semFlag.follow_up_config?.disqualify_after_final === undefined, semFlag.follow_up_config);

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
