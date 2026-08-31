// Targeting v4 Alves Cury × corpos REAIS da janela 26-28/08 (regra H85: replay
// no corpus de produção antes de declarar pronto).
// Rodar: npx tsx scripts/test-alves-targeting-v4.ts
import { evaluateTargetingSet, normalizeTargeting } from "@/lib/queue/targeting";
import type { TargetingRules } from "@/lib/queue/targeting";

const CF_AI = "C7LzKTXG3QHJuzfqOi9T";
const CF_TIPO = "tUpk31fRxXs2bhxXYMh5";

const BRUNO_V4 = {
  version: 2,
  match: "any",
  groups: [
    { id: "g-int-recruit", match: "all", rules: [{ id: "r-msg-agente", type: "message", message_operator: "contains", message_value: "agente financeiro" }] },
    { id: "g-headline-recruit", match: "all", rules: [{ id: "r-headline", type: "message", message_operator: "contains", message_value: "Oportunidade para brasileiros" }] },
    { id: "g-campo-ai", match: "all", rules: [{ id: "ac-cf-recruit", type: "custom_field", custom_field_key: CF_AI, custom_field_value: "Recruit" }] },
    { id: "g-campo-tipo", match: "all", rules: [{ id: "r-tipo-recruit", type: "custom_field", custom_field_key: CF_TIPO, custom_field_value: "Recrutamento" }] },
  ],
} as unknown as TargetingRules;

const BRUNA_V4 = {
  version: 2,
  match: "any",
  groups: [
    { id: "g-int-seguro", match: "all", rules: [{ id: "r-msg-seguro", type: "message", message_operator: "contains", message_value: "seguro" }] },
    { id: "g-int-protecao", match: "all", rules: [{ id: "r-msg-protecao", type: "message", message_operator: "contains", message_value: "proteção financeira" }] },
    { id: "g-headline-venda", match: "all", rules: [{ id: "r-headline-v", type: "message", message_operator: "contains", message_value: "Uma história real de proteção" }] },
    { id: "g-campo-ai", match: "all", rules: [{ id: "ac-cf-venda", type: "custom_field", custom_field_key: CF_AI, custom_field_value: "Venda" }] },
    { id: "g-campo-tipo", match: "all", rules: [{ id: "r-tipo-venda", type: "custom_field", custom_field_key: CF_TIPO, custom_field_value: "Venda" }] },
  ],
} as unknown as TargetingRules;

// Corpos REAIS (message_queue 26-28/08)
const ANDREIA =
  "*Headline:* Oportunidade para brasileiros nos EUA\n*Source URL:* https://www.instagram.com/p/DbrULUiAcW0/\n\nMoro nos EUA e gostaria de mais informações de como me tornar agente financeiro";
const JOSE_SO_HEADLINE = "*Headline:* Uma história real de proteção\n*Source URL:* https://fb.me/4HlyIS3BR\n\n";
const AD_VENDA = "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida";
const ELIUMAR = "Obrigado 🙏"; // cliente existente — NÃO pode casar
const TCMI = "Ta bem";
const CASSIA_IG = "Olá!\nEu não achei vocês no Google.\nAinda estão abertos?";
const RECRUT_SEM_ACENTO = "moro nos eua e gostaria de mais informacoes de como me tornar agente financeiro"; // lead que digita sem acento

type Contato = { id: string; tags?: string[]; customFields?: Array<{ id: string; value: string }> } | null;
function roteia(msg: string, contato: Contato): "BRUNO" | "BRUNA" | "ninguém" {
  // ordem do roteador real: created_at ASC = Bruno primeiro
  for (const [nome, rules] of [["BRUNO", BRUNO_V4], ["BRUNA", BRUNA_V4]] as const) {
    const set = normalizeTargeting(rules)!;
    if (evaluateTargetingSet(set, contato as never, [], { messageText: msg })) return nome;
  }
  return "ninguém";
}

let pass = 0;
let fail = 0;
function caso(nome: string, got: string, want: string) {
  if (got === want) {
    pass++;
    console.log(`  ✅ ${nome} → ${got}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome} → got ${got}, want ${want}`);
  }
}

const semCampos: Contato = { id: "x", tags: ["ads_lead"], customFields: [] };

caso("Andréia (anúncio recrutamento, texto completo)", roteia(ANDREIA, semCampos), "BRUNO");
caso("Jose (anúncio venda SÓ headline, sem texto)", roteia(JOSE_SO_HEADLINE, semCampos), "BRUNA");
caso("template venda completo", roteia(AD_VENDA, semCampos), "BRUNA");
caso("recrutamento digitado sem acento", roteia(RECRUT_SEM_ACENTO, semCampos), "BRUNO");
caso("cliente existente 'Obrigado 🙏' NÃO casa", roteia(ELIUMAR, { id: "e", tags: ["client"], customFields: [] }), "ninguém");
caso("'Ta bem' NÃO casa", roteia(TCMI, semCampos), "ninguém");
caso("IG orgânico 'estão abertos?' NÃO casa (política pendente)", roteia(CASSIA_IG, { id: "c", tags: [], customFields: [] }), "ninguém");
caso(
  "campo AI=Venda casa mesmo sem texto",
  roteia("oi", { id: "j", tags: [], customFields: [{ id: CF_AI, value: "Venda" }] }),
  "BRUNA",
);
caso(
  "campo tipo=Recrutamento (workflow do Marcos) casa",
  roteia("oi", { id: "r", tags: [], customFields: [{ id: CF_TIPO, value: "Recrutamento" }] }),
  "BRUNO",
);
caso(
  "AI=Off não ativa ninguém por si",
  roteia("oi", { id: "o", tags: [], customFields: [{ id: CF_AI, value: "Off" }] }),
  "ninguém",
);
// lead que menciona seguro num pedido de carreira: intenção dupla — Bruno ganha
// pela ordem (e faz virada-cliente se preciso; nunca nega a outra frente).
caso(
  "'quero ser agente financeiro e vender seguro' → Bruno (ordem)",
  roteia("quero ser agente financeiro e vender seguro", semCampos),
  "BRUNO",
);

console.log(`\n${pass} ✅ / ${fail} ❌`);
process.exit(fail > 0 ? 1 : 0);
