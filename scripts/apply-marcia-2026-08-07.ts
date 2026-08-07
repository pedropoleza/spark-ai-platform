/**
 * Ajustes de COMPORTAMENTO no agente de vendas da Five Star Ricos / Horizon
 * (location jA6uzx6tONyTeocxw4Cj), pedidos pela Márcia entre 04 e 06/08.
 * Fonte: spark-os/_planning/sessoes/PROMPT_IA_AGENDAMENTO.md (itens E, G e H).
 *
 *   E — identidade: "tem usado o nome da Rob dnv" (06/08 17:26). A IA assina como
 *       Roberta. Pedido (04/08 12:47): apresentar-se como "a Márcia e a Roberta".
 *   G — coleta picada: "colocar um lembrete para a Iá para quando ela for pedir os
 *       dados, já pedir no estilo que a gente pedia antes, NA SEQUÊNCIA: primeiro e
 *       último nome, data de nascimento, estado que você mora e se é fumante ou
 *       não" (06/08 12:29) + "eles estão mandando picada e às vezes a gente não vê
 *       se a pessoa é fumante ou não" (12:30). Nota interna: "colocar todas as
 *       perguntas na mesma mensagem".
 *       ⚠️ Faltava `full_name` nos data_fields — a IA nunca pedia nome/sobrenome.
 *   H — sequência de follow-up de 3 toques que ela mandou em 05/08 12:10 e que
 *       nunca foi implementada. Texto dela, verbatim.
 *
 * NÃO mexe em: fuso (corrigido no banco), targeting, calendário, modelo.
 *
 *   npx tsx -r tsconfig-paths/register scripts/apply-marcia-2026-08-07.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENT_ID = "7c0a72b7-e37c-463d-be56-73b7822a3037"; // Agente de Vendas (Horizon)

// ---------------------------------------------------------------------------
// E + G no custom_instructions. Zero travessão.
// ---------------------------------------------------------------------------
const PROMPT = `# QUEM ATENDE
Você atende em nome da equipe: a Márcia e a Roberta. Quando precisar se referir a quem atende, fale no plural ("a gente", "nosso time") ou "a Márcia e a Roberta". NUNCA assine a mensagem com um nome sozinho, NUNCA se apresente como "Rob" ou "Roberta", e NUNCA diga que é a Roberta falando. Ao encaminhar, diga que vai passar pra "a especialista" (feminino, é o time todo).

# COMO PEDIR OS DADOS (regra desta conta)
Os 4 dados vão TODOS NA MESMA MENSAGEM, nesta ordem exata, numa lista curta:
1. primeiro e último nome
2. data de nascimento
3. estado onde mora
4. se é fumante ou não

NUNCA peça um dado por vez nem quebre em várias mensagens: chega picado do outro lado e a equipe perde a informação (principalmente o fumante). Peça os 4 de uma vez, de forma leve, e só volte a cobrar o que a pessoa REALMENTE não respondeu. Se ela responder só uma parte, agradeça e cobre apenas o que faltou, de novo tudo junto numa mensagem só.
Se algum dado já veio na conversa ou já está no cadastro, NÃO repergunte.

# ESTILO
Objetivo, educado e humano. Mensagens curtas, sem textão. Nunca escreva "/n" nem qualquer marcador de quebra de linha no texto.

# DEPOIS DA COLETA
Com os 4 dados, faça o agendamento e diga que a especialista entra em contato com mais detalhes.`;

// ---------------------------------------------------------------------------
// G: faltava o nome. Ordem = a ordem que ela pediu.
// ---------------------------------------------------------------------------
const DATA_FIELDS = [
  { key: "full_name", type: "text", label: "Primeiro e último nome", required: true },
  {
    key: "contact.dateOfBirth", type: "date", label: "Date of Birth", required: true,
    sync_to_ghl: true, ghl_field_id: "contact.dateOfBirth", ghl_field_key: "contact.dateOfBirth",
  },
  {
    key: "contact.state", type: "text", label: "Estado", required: true,
    sync_to_ghl: true, ghl_field_id: "contact.state", ghl_field_key: "contact.state",
  },
  {
    key: "jbtzPbXxa5vqXiON9GrK", type: "boolean", label: "Fumante?", required: true,
    sync_to_ghl: true, ghl_field_id: "jbtzPbXxa5vqXiON9GrK", ghl_field_key: "contact.are_you_a_smoker",
  },
];

// ---------------------------------------------------------------------------
// H: os 3 toques, texto da Márcia (05/08 12:10). Modo manual = texto dela sai
// como está, sem a IA reescrever. Delays: ~1h, 24h+, 72h+.
// A janela de envio (08h-21h no fuso da conta) é aplicada pelo scheduler —
// nenhum toque cai de madrugada como o das (862) 371-8457.
// ---------------------------------------------------------------------------
const FOLLOWUP = {
  enabled: true,
  mode: "manual" as const,
  intensity: 2,
  max_attempts: 3,
  min_delay_minutes: 60,
  max_delay_minutes: 10080,
  manual_steps: [
    {
      delay_minutes: 60,
      custom_message: "Oie! Vi que chegou pelo vídeo do Matheus 🙂 Me manda seus dados rapidinho?",
    },
    {
      delay_minutes: 1440,
      custom_message:
        "Oie... Ficar parado meses por um acidente é o medo de todo brasileiro que trabalha pesado. Separei um relato de quem passou por isso, vamos marcar um horário?",
    },
    {
      delay_minutes: 4320,
      custom_message:
        "Oie, tudo bem? Quer que eu pause por aqui ou prefere me enviar os dados quando puder? Ninguém quer descobrir na hora do aperto quem paga as contas, só me diz quando podemos conversar.",
    },
  ],
  custom_prompt:
    "Follow-up desta conta é CURTO (1-2 frases) e serve só pra retomar: nunca re-explicar o produto, nunca re-listar os dados. Se a última mensagem da conversa foi NOSSA e nada mudou desde o último toque, use SÓ o marcador [[NAO_ENVIAR]].",
};

async function main() {
  if (/—/.test(PROMPT)) throw new Error("prompt tem travessão (—)");
  if (PROMPT.length > 8000) throw new Error(`prompt tem ${PROMPT.length} chars (>8000)`);
  if (!/fumante/i.test(PROMPT)) throw new Error("ordem de coleta sumiu do prompt");

  const supabase = createAdminClient();

  const { data: antes } = await supabase
    .from("agent_configs")
    .select("personality, data_fields, follow_up_config, custom_instructions")
    .eq("agent_id", AGENT_ID)
    .maybeSingle();
  if (!antes) throw new Error(`config do agente ${AGENT_ID} não encontrada`);

  const personality = {
    ...((antes.personality as Record<string, unknown>) || {}),
    // E: o nome da persona some. A identidade agora é o time (fica no prompt).
    name: "Equipe Márcia e Roberta",
    persona_description:
      "Primeiro contato da equipe da Márcia e da Roberta. Fala em nome das duas, nunca assina com um nome sozinho. Coleta os 4 dados numa mensagem só e agenda com a especialista.",
  };

  const { error } = await supabase
    .from("agent_configs")
    .update({
      personality,
      specialist_name: "a especialista",
      data_fields: DATA_FIELDS,
      follow_up_config: FOLLOWUP,
      custom_instructions: PROMPT,
    })
    .eq("agent_id", AGENT_ID);
  if (error) throw new Error(`UPDATE agent_configs: ${error.message}`);

  console.log(`✅ Agente de Vendas (Horizon) atualizado — ${AGENT_ID}`);
  console.log(`   E  identidade: "Equipe Márcia e Roberta" + regra de nunca assinar como Rob`);
  console.log(`   G  data_fields: ${DATA_FIELDS.length} campos (full_name ADICIONADO) + regra "os 4 numa mensagem só"`);
  console.log(`   H  follow-up: manual, 3 toques (1h / 24h / 72h) com o texto da Márcia`);
  console.log(`\n⚠️  O toque 1 cita "o vídeo do Matheus" (texto dela). Se o agente atender leads de`);
  console.log(`   outra campanha, esse toque vai soar errado pra eles — confirmar com ela.`);
  console.log(`⚠️  O toque 2 pedia VÍDEO anexo. Follow-up só manda TEXTO hoje; o vídeo não vai.`);
  process.exit(0);
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
