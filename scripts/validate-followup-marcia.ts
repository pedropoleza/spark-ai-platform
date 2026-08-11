/**
 * Validação REAL do follow-up da conta da Márcia (H73, 2026-08-11).
 *
 * Não é unit test: monta o prompt exatamente como o runner monta, com a config
 * de produção do agente e o histórico REAL do contato que a dona reportou, e
 * chama o modelo de verdade. O que sai aqui é o que sairia pro lead.
 *
 * Cenários (o 1º é o caso do print — "o cliente passou os dados e a IA ficou
 * num looping de tentar pegar os dados dele"):
 *   A) lead JÁ mandou todos os dados     → NÃO pode pedir os dados de novo
 *   B) lead sumiu sem mandar nada        → texto do admin sai como está
 *   C) toque que promete "separei um relato" → NÃO pode prometer envio
 *   D) lead adiou pra semana que vem     → não manda nada
 *
 * Rodar: npx tsx scripts/validate-followup-marcia.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { buildFollowUpPrompt } from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";

const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

/** Pedir dado que o lead já mandou é o defeito que estamos caçando. */
const PEDE_DADOS =
  /(me\s+manda|manda|envia|passa|preciso).{0,40}(seus?\s+)?dados|dados\s+rapidinho|qual\s+sua\s+data\s+de\s+nascimento|nome\s+e\s+sobrenome\b(?!.*c[ôo]njuge)/i;
const PROMETE_MATERIAL =
  /(separei|vou (te )?mandar|te envio|segue|mando)\s+(um|o|uns|alguns)?\s*(relato|v[íi]deo|material|print|depoimento|áudio|audio)/i;

type Cenario = {
  nome: string;
  passo: number;
  historico: string;
  coletados: Record<string, string>;
  esperado: (texto: string, naoEnviou: boolean) => { ok: boolean; porque: string };
};

const CENARIOS: Cenario[] = [
  {
    nome: "A) lead JÁ mandou todos os dados (caso real, contato DfVDzxNrxvHsGpmlhtoc)",
    passo: 1,
    historico: [
      "LEAD: O que tenho q fazer",
      "AGENTE: É simples! A gente só precisa de alguns dados seus pra preparar a cotação e aí a especialista te liga pra apresentar tudo direitinho. Me passa essas informações: • Nome e sobrenome • Data de nascimento • Estado onde mora • É fumante? Se for casado(a), manda os dados do cônjuge também",
      "LEAD: Rosilede Alves da silva 1/12/1974 Newark NJ Sim fumante Casada",
      "AGENTE: Anotei tudo, Rosilede! Só falta o nome e sobrenome do seu cônjuge, a data de nascimento dele(a) e se é fumante também",
    ].join("\n"),
    coletados: {
      full_name: "Rosilede Alves da Silva",
      "contact.dateOfBirth": "1/12/1974",
      "contact.state": "NJ",
      jbtzPbXxa5vqXiON9GrK: "sim",
    },
    esperado: (texto, naoEnviou) => {
      if (naoEnviou) return { ok: true, porque: "optou por não mandar (aceitável — não repete o pedido)" };
      if (PEDE_DADOS.test(texto)) return { ok: false, porque: "PEDIU OS DADOS DE NOVO (o bug do print)" };
      return { ok: true, porque: "não repetiu o pedido de dados" };
    },
  },
  {
    nome: "B) lead sumiu sem mandar nada (para quem o texto do admin foi escrito)",
    passo: 1,
    historico: [
      "LEAD: 📢 Veio de anúncio (instagram)",
      "AGENTE: Que bom que você chegou 😊 Somos a Márcia e a Roberta, especialistas em seguro de vida com benefícios em vida aqui nos EUA.",
    ].join("\n"),
    coletados: {},
    esperado: (texto, naoEnviou) => {
      if (naoEnviou) return { ok: false, porque: "ficou calada num lead que sumiu sem dar dados" };
      return { ok: true, porque: "mandou o toque (pedir dados aqui é correto)" };
    },
  },
  {
    nome: "C) toque #2, que no texto do admin promete 'separei um relato'",
    passo: 2,
    historico: [
      "LEAD: 📢 Veio de anúncio (instagram)",
      "AGENTE: Que bom que você chegou 😊 Somos a Márcia e a Roberta.",
      "AGENTE: Oie! Me manda seus dados rapidinho?",
    ].join("\n"),
    coletados: {},
    esperado: (texto, naoEnviou) => {
      if (naoEnviou) return { ok: true, porque: "não mandou (não promete nada)" };
      if (PROMETE_MATERIAL.test(texto)) return { ok: false, porque: "PROMETEU material que a gente não envia" };
      return { ok: true, porque: "não prometeu enviar material" };
    },
  },
  {
    nome: "D) lead adiou pra semana que vem",
    passo: 1,
    historico: [
      "LEAD: 📢 Veio de anúncio (instagram)",
      "AGENTE: Somos a Márcia e a Roberta. Me manda seus dados?",
      "LEAD: to viajando, semana que vem eu te falo",
      "AGENTE: Tranquilo! Fico no aguardo.",
    ].join("\n"),
    coletados: {},
    esperado: (texto, naoEnviou) => {
      if (naoEnviou) return { ok: true, porque: "ficou quieta, como deveria" };
      return { ok: false, porque: "cutucou quem pediu pra esperar" };
    },
  },
];

async function main() {
  const { data } = await sb.from("agent_configs").select("*").eq("agent_id", AGENT).single();
  const config = data as Record<string, unknown>;
  const passos = ((config.follow_up_config as { manual_steps?: Array<{ custom_message?: string }> })?.manual_steps) ?? [];
  console.log(`config de produção lida. passos configurados: ${passos.length}`);
  console.log(`modelo: ${config.ai_model}\n`);

  let ok = 0;
  let falhou = 0;

  for (const cen of CENARIOS) {
    const sugerida = passos[cen.passo - 1]?.custom_message;
    const prompt = buildFollowUpPrompt({
      config: config as never,
      agentType: "sales_agent",
      attemptNumber: cen.passo,
      locationName: "Five Star Ricos",
      currentDate: new Date().toLocaleDateString("pt-BR"),
      timezone: "America/New_York",
      contactName: cen.passo === 1 && Object.keys(cen.coletados).length ? "Rosilede" : "Cliente",
      collectedData: cen.coletados,
      recentHistory: cen.historico,
      mensagemSugerida: sugerida,
    });

    const r = await processWithAI({
      systemPrompt: prompt,
      conversationHistory: "",
      newMessages: `Follow-up #${cen.passo} para o lead. Gere uma unica mensagem de follow-up.`,
      model: String(config.ai_model || "gpt-4.1-mini"),
    });

    const bruto = r.response?.message;
    const texto = Array.isArray(bruto) ? bruto.join(" ") : String(bruto ?? "");
    const naoEnviou = /\[\[\s*NAO_ENVIAR\s*\]\]/i.test(texto) || !texto.trim();
    const v = cen.esperado(texto, naoEnviou);

    console.log(`${v.ok ? "✅" : "❌"} ${cen.nome}`);
    console.log(`   sugerido : "${String(sugerida ?? "(nenhum)").slice(0, 80)}"`);
    console.log(`   saiu     : ${naoEnviou ? "(NÃO ENVIA)" : `"${texto.slice(0, 160)}"`}`);
    console.log(`   veredito : ${v.porque}\n`);
    v.ok ? ok++ : falhou++;
  }

  console.log(`${ok}/${ok + falhou} cenários corretos`);
  process.exit(falhou === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
