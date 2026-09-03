/**
 * Check da "entrada pela automação" na conta da Márcia (H90) — e correção
 * automática do que é seguro corrigir.
 *
 * O que verifica, desde o deploy (ou --desde=ISO):
 *  A) CONFIG: a config do agente ainda é a validada (snapshot de 03/09):
 *     targeting só por tag, sem `abertura-audio`, flags, regra de AI Status,
 *     prompt com a regra de entrada e sem a regra antiga de lista.
 *  B) WORKFLOW: "Incoming Lead > Message - v81" continua publicado (é ele que
 *     abre a conversa; a API não permite religar — só alerta).
 *  C) LEADS NOVOS: pra cada contato que entrou, a 1ª mensagem foi silenciada,
 *     a IA respondeu na 2ª, e essa resposta não se apresenta, não repete a
 *     lista dos 4 dados e não promete áudio. Lead que chegou SEM a tag e ficou
 *     sem resposta = workflow não adicionou a tag (aviso).
 *  D) IA DESLIGADA: nenhum contato com "AI Status: Inactive" recebeu mensagem.
 *  E) DUPLICAÇÃO: nos 10 min após a 1ª mensagem, o pedido de dados saiu 1 vez.
 *
 * --fix: restaura do snapshot os campos de config que divergiram (só eles),
 * garante a regra de AI Status e remove `abertura-audio` se voltou. O que não
 * dá pra corrigir por código (workflow despublicado, modelo se apresentando
 * com o prompt certo) vira FAIL + admin_signal.
 *
 * Rodar: npx tsx scripts/check-marcia-entrada.ts [--fix] [--desde=2026-09-03T22:00:00Z]
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });
import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import { GHLClient } from "@/lib/ghl/client";
import { reportError } from "@/lib/admin-signals/report-error";
import type { DeactivationRule } from "@/types/agent";

const FIX = process.argv.includes("--fix");
const DESDE = (process.argv.find((a) => a.startsWith("--desde=")) ?? "").split("=")[1] || "2026-09-03T22:00:00Z";
const LOC = "jA6uzx6tONyTeocxw4Cj", COMPANY = "TdmQMjj86Y3LgppiB96K", AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const WORKFLOW_ENTRADA = "fa30ba26-fc18-4f09-b445-c19a510bef45";
const AI_STATUS_FIELD = "EVbZXt7c2AM5dqI9DTcb";
const SNAP_PATH = "_planning/five-star-ricos-2026-07-21/marcia-config-snapshot-2026-09-03.json";
const MARCADOR_ENTRADA = "QUEM ABRE A CONVERSA É A AUTOMAÇÃO";
const REGRA_ANTIGA_LISTA = "Peça os 4 JUNTOS";

const SE_APRESENTA = /somos a m[áa]rcia|que bom que voc[êe] chegou|n[óo]s somos|especialistas em seguro de vida/i;
const PROMETE_AUDIO = /audiozinho|te mandando um [áa]udio|vou te mandar um [áa]udio/i;
const PEDE_DADOS = /nome e sobrenome|nome completo|data de nascimento|me passa (seus|esses) dados/i;
const LISTA_4 = (t: string) => (t.match(/•/g) ?? []).length >= 3 || (t.split("\n").length >= 4 && /nome/i.test(t) && /nascimento/i.test(t) && /estado/i.test(t) && /fum/i.test(t));

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const falhas: string[] = [], avisos: string[] = [], corrigidos: string[] = [], oks: string[] = [];
const FAIL = (m: string) => falhas.push(m), WARN = (m: string) => avisos.push(m), OK = (m: string) => oks.push(m), FIXED = (m: string) => corrigidos.push(m);

type Cfg = Record<string, unknown> & { deactivation_rules?: DeactivationRule[]; automations?: Array<{ id: string }> };

async function checkConfig(): Promise<void> {
  const snap = JSON.parse(fs.readFileSync(SNAP_PATH, "utf8")) as Cfg;
  const { data } = await sb.from("agent_configs").select("*").eq("agent_id", AGENT).single();
  const cfg = data as Cfg;
  const patch: Record<string, unknown> = {};

  const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!mesmo(cfg.targeting_rules, snap.targeting_rules)) { patch.targeting_rules = snap.targeting_rules; FAIL("A: targeting divergiu do validado (só tag 'ai qualification active')"); } else OK("A: targeting só por tag");
  for (const f of ["entry_by_automation", "suppress_ad_context_turn", "allow_silent_turns", "activation_mode"] as const) {
    if (!mesmo(cfg[f], snap[f])) { patch[f] = snap[f]; FAIL(`A: ${f} = ${JSON.stringify(cfg[f])} (validado: ${JSON.stringify(snap[f])})`); }
  }
  const autos = cfg.automations ?? [];
  if (autos.some((a) => a.id === "abertura-audio")) { patch.automations = autos.filter((a) => a.id !== "abertura-audio"); FAIL("A: automação 'abertura-audio' voltou (áudio em dobro com o workflow)"); } else OK("A: sem abertura-audio (o workflow manda o áudio)");
  const regras = cfg.deactivation_rules ?? [];
  const temRegra = regras.some((r) => r.type === "custom_field_equals" && r.field_key === AI_STATUS_FIELD && r.field_value === "Inactive");
  if (!temRegra) { patch.deactivation_rules = [{ id: "ai-status-inactive", type: "custom_field_equals", field_key: AI_STATUS_FIELD, field_value: "Inactive" }, ...regras]; FAIL("A: regra 'AI Status = Inactive' sumiu das regras de desligamento"); } else OK("A: regra AI Status=Inactive presente");
  const prompt = String(cfg.system_prompt_override ?? "");
  if (!prompt.includes(MARCADOR_ENTRADA) || prompt.includes(REGRA_ANTIGA_LISTA)) { patch.system_prompt_override = snap.system_prompt_override; FAIL("A: prompt perdeu a regra de entrada (ou a regra antiga de lista voltou)"); } else OK("A: prompt com a regra de entrada");
  if (!String(cfg.custom_instructions ?? "").includes("feita pela AUTOMAÇÃO")) { patch.custom_instructions = snap.custom_instructions; FAIL("A: custom_instructions perdeu o alinhamento da entrada"); }

  if (Object.keys(patch).length && FIX) {
    const { error } = await sb.from("agent_configs").update(patch).eq("agent_id", AGENT);
    if (error) FAIL(`A: --fix falhou ao restaurar: ${error.message}`);
    else FIXED(`A: restaurado do snapshot: ${Object.keys(patch).join(", ")}`);
  }
}

async function checkWorkflow(c: GHLClient): Promise<void> {
  const w = await c.get<{ workflows?: Array<{ id: string; name: string; status: string }> }>("/workflows/", { locationId: LOC });
  const wf = (w.workflows ?? []).find((x) => x.id === WORKFLOW_ENTRADA);
  if (wf?.status === "published") OK("B: workflow de entrada publicado");
  else FAIL(`B: workflow de entrada está "${wf?.status ?? "sumiu"}" — ninguém abre a conversa (não dá pra religar por API)`);
}

type Ev = { created_at: string; contact_id: string; action_type: string; action_payload: Record<string, unknown> | null };

async function checkLeads(c: GHLClient): Promise<void> {
  const { data } = await sb.from("execution_log").select("created_at,contact_id,action_type,action_payload")
    .eq("location_id", LOC).gte("created_at", DESDE).order("created_at").limit(3000);
  const evs = (data ?? []) as Ev[];
  const por = new Map<string, Ev[]>();
  for (const e of evs) { const l = por.get(e.contact_id) ?? []; l.push(e); por.set(e.contact_id, l); }

  let entraram = 0, responderam = 0, semTag = 0, desligados = 0;
  for (const [cid, lista] of por) {
    const entrada = lista.find((e) => e.action_type === "entry_suppressed");
    const skips = lista.filter((e) => e.action_type === "targeting_skip");
    const respostas = lista.filter((e) => e.action_type === "send_message" && (e.action_payload as { source?: string } | null)?.source !== "follow_up");
    const pausas = lista.filter((e) => e.action_type === "ai_paused" && /human_message/.test(String((e.action_payload as { reason?: string } | null)?.reason ?? "")));
    if (lista.some((e) => e.action_type === "deactivated_by_rule_skip")) desligados++;

    if (entrada) {
      entraram++;
      const primeira = respostas.find((r) => r.created_at > entrada.created_at);
      if (primeira) {
        responderam++;
        const texto = ((primeira.action_payload as { message?: string[] } | null)?.message ?? []).join("\n");
        const prob: string[] = [];
        if (SE_APRESENTA.test(texto)) prob.push("SE APRESENTOU");
        if (LISTA_4(texto)) prob.push("REPETIU A LISTA");
        if (PROMETE_AUDIO.test(texto)) prob.push("PROMETEU ÁUDIO");
        if (prob.length) FAIL(`C: ${cid} — 1ª resposta da IA ${prob.join(" + ")}: ${JSON.stringify(texto.slice(0, 120))}`);
        if (pausas.some((p) => p.created_at > entrada.created_at && p.created_at < primeira.created_at)) FAIL(`C: ${cid} — IA auto-pausou entre a entrada e a resposta (leu o workflow como humano)`);
      }
      // E) duplicação nos 10 min após a entrada
      try {
        const cv = await c.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: LOC, contactId: cid });
        const cidConv = cv.conversations?.[0]?.id;
        if (cidConv) {
          const m = await c.get<{ messages?: { messages?: Array<{ direction: string; body?: string; dateAdded: string; messageType?: string }> } }>(`/conversations/${cidConv}/messages`, { locationId: LOC });
          const t0 = new Date(entrada.created_at).getTime();
          const janela = (m.messages?.messages ?? []).filter((x) => x.direction === "outbound" && /SMS|WHATSAPP/i.test(String(x.messageType)) && Math.abs(new Date(x.dateAdded).getTime() - t0) < 10 * 60_000);
          const pedidos = janela.filter((x) => PEDE_DADOS.test(String(x.body ?? "")));
          if (pedidos.length > 1) FAIL(`E: ${cid} — pedido de dados saiu ${pedidos.length}x em 10 min (${janela.length} msgs)`);
        }
      } catch (e) { WARN(`E: ${cid} — não consegui ler a conversa (${(e as Error).message.slice(0, 60)})`); }
    } else if (skips.length && respostas.length === 0) {
      semTag++;
    }
  }
  if (entraram === 0) WARN(`C: nenhum lead entrou pelo fluxo desde ${DESDE} — nada a validar ainda`);
  else OK(`C: ${entraram} lead(s) entraram; ${responderam} já responderam e a IA continuou`);
  if (semTag > 0) WARN(`C: ${semTag} contato(s) chegaram SEM a tag e ficaram sem resposta — conferir se o workflow está adicionando 'AI qualification active'`);
  if (desligados > 0) OK(`D: ${desligados} contato(s) com IA desligada foram corretamente ignorados`);
}

async function checkInativos(c: GHLClient): Promise<void> {
  // Cuidado com o sintoma: comparar o valor de HOJE do campo com envios do
  // PASSADO acusa violação onde não há (1ª rodada deste check, 03/09: a IA
  // agendou às 22:01:39 e um workflow marcou Inactive às 22:01:53). Só é
  // violação se a IA mandou mensagem DEPOIS da última atualização do contato
  // (o campo já estava Inactive na hora do envio) e o gate não bloqueou.
  const { data } = await sb.from("execution_log").select("contact_id,created_at,action_type")
    .eq("location_id", LOC).in("action_type", ["send_message", "deactivated_by_rule_skip"]).gte("created_at", DESDE).order("created_at").limit(3000);
  const ultimoEnvio = new Map<string, string>(), ultimoSkip = new Map<string, string>();
  for (const x of (data ?? []) as Array<{ contact_id: string; created_at: string; action_type: string }>) {
    (x.action_type === "send_message" ? ultimoEnvio : ultimoSkip).set(x.contact_id, x.created_at);
  }
  let indevidos = 0, conferidos = 0, viraramDepois = 0;
  for (const [id, envio] of ultimoEnvio) {
    try {
      const ct = await c.get<{ contact?: { dateUpdated?: string; customFields?: Array<{ id: string; value?: unknown }> } }>(`/contacts/${id}`);
      conferidos++;
      const v = ct.contact?.customFields?.find((f) => f.id === AI_STATUS_FIELD)?.value;
      if (String(v) !== "Inactive") continue;
      const atualizado = ct.contact?.dateUpdated ?? "";
      const skipDepois = (ultimoSkip.get(id) ?? "") > envio;
      if (envio > atualizado && !skipDepois) { indevidos++; FAIL(`D: ${id} já estava 'AI Status: Inactive' (atualizado ${atualizado.slice(11, 19)}Z) e a IA mandou mensagem às ${envio.slice(11, 19)}Z`); }
      else viraramDepois++;
    } catch { /* contato sumiu */ }
  }
  if (indevidos === 0) OK(`D: nenhum contato Inactive recebeu mensagem indevida (${conferidos} conferidos; ${viraramDepois} viraram Inactive depois da última mensagem, ex.: pós-agendamento)`);
}

async function main() {
  console.log(`check-marcia-entrada · desde ${DESDE} · ${FIX ? "COM --fix" : "só leitura"}\n`);
  const c = new GHLClient(COMPANY, LOC);
  await checkConfig();
  await checkWorkflow(c).catch((e) => FAIL(`B: erro ao consultar workflows: ${(e as Error).message.slice(0, 80)}`));
  await checkLeads(c);
  await checkInativos(c);

  if (FIX && corrigidos.length) {
    // re-checa a config depois de restaurar
    const antes = falhas.length; falhas.length = 0; oks.length = 0;
    await checkConfig();
    console.log(`(pós-fix: ${antes} falha(s) antes, ${falhas.length} depois)`);
  }

  for (const o of oks) console.log(`  ✅ ${o}`);
  for (const w of avisos) console.log(`  ⚠️  ${w}`);
  for (const f of corrigidos) console.log(`  🔧 ${f}`);
  for (const f of falhas) console.log(`  ❌ ${f}`);
  const veredito = falhas.length === 0 ? "TUDO CERTO" : `${falhas.length} FALHA(S)`;
  console.log(`\nVEREDITO: ${veredito}${corrigidos.length ? ` (${corrigidos.length} corrigida(s) automaticamente)` : ""}`);
  if (falhas.length) {
    reportError({ title: "Check diário da entrada pela automação (Márcia): falhas", feature: "check-marcia-entrada", severity: "high",
      description: falhas.join(" | ").slice(0, 900), metadata: { locationId: LOC, agentId: AGENT, desde: DESDE, fix: FIX, corrigidos } });
    await new Promise((r) => setTimeout(r, 800));
  }
  process.exit(falhas.length ? 1 : 0);
}
main().catch((e) => { console.error("ERRO NO CHECK:", e); process.exit(2); });
