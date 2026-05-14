// Backfill manual das notas que Gustavo (cliente +1 754-265-0461) pediu
// pra criar em 14/05/2026 entre 16:14-16:21 ET. Bot mentiu 8 vezes
// dizendo "Nota salva" sem chamar create_note (confirmation_mode=high_only
// não bloqueia mas LLM literalmente ignorou a regra).
//
// Este script repõe as notas no GHL direto, na ordem cronológica que o
// rep enviou, pra cada um dos 3 contatos.
//
// Roda com: npx tsx -r tsconfig-paths/register scripts/backfill-gustavo-notes.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { createNoteOnContact } from "@/lib/ghl/operations";

const GUSTAVO_LOC = "b1ttBRVEnm5joFvP2UXO";

const BACKFILL: Array<{
  contact_id: string;
  contact_name: string;
  notes: string[];
}> = [
  {
    contact_id: "0mj7aXpbxEi1jKcyb0Pb",
    contact_name: "Renata Brugger",
    notes: [
      // 16:14:33 ET — respostas qualificatórias (4 perguntas)
      `1- Porque eu já estava procurando algum trabalho que eu conseguisse ter uma certa liberdade de tempo, por ter 2 filhos, e uma ser bem pequena. Que se algum filho meu tivesse algum problema, eu não precisasse ter que faltar algum trabalho presencial para ficar com eles. E porque depois de um tempo vendo na internet muita gente falando a respeito de agente financeiro, eu fiquei interessada em juntar a liberdade com o financeiro! E pelo fato de poder não precisar saber nada e começar do zero a aprender!
2- Porque eu acho que eu teria muito a acrescentar a empresa de vocês, e seria uma grande oportunidade para minha vida profissional!
3- Tenho capacidade sim! Até porque é um investimento que vai me ajudar no futuro!
4- Quando eu olhar para esse ano trabalhado, e ver quantas pessoas eu consegui ajudar, e ao mesmo tempo ajudando a minha família financeiramente, não deixando de perder qualidade de vida com a família!`,
    ],
  },
  {
    contact_id: "mNnyriY6Pvtn4x2YK4nv",
    contact_name: "Caroline Estercio",
    notes: [
      // 16:18:29 ET
      `Acredito que essa é a oportunidade ideal porque está totalmente alinhada com meus objetivos pessoais e profissionais. Busco liberdade geográfica, alto potencial de ganhos e um ambiente que me desafie constantemente a evoluir. Além disso, ter acesso a um treinamento estruturado e suporte para acelerar meu crescimento torna essa oportunidade ainda mais estratégica para alcançar resultados concretos.`,
      // 16:19:13 ET
      `Eu tenho experiência com vendas, falo 3 idiomas (inglês português e espanhol) e tenho fome de resultados, trabalhar com a ideial dos meus rendimentos dependerem do meu desempenho não me assusta, me motiva`,
      // 16:19:32 ET
      `Sim, tenho total capacidade de realizar os investimentos necessários`,
      // 16:19:59 ET
      `Alcançar, no mínimo, $100 mil em faturamento e, mais importante, desenvolver um nível de consistência e previsibilidade nos resultados que me permita escalar ainda mais nos anos seguintes`,
      // 16:20:10 ET
      `Mora em Lake Tahoe. Meta até o fim do ano: sair dos trabalhos braçais. Gosta muito de vendas. Vendeu $1,000,000 em processos de registro de marca no Brasil e também trabalhou em um pequeno escritório de wealth management.`,
    ],
  },
  {
    contact_id: "BOdwgNNIQbRvJL4WfxYI",
    contact_name: "Giovanna Filippi",
    notes: [
      // 16:20:56 ET — respostas qualificatórias (4 perguntas)
      `1- Eu vejo  essa oportunidade como ideal para mim porque quero construir uma carreira sólida aqui nos Estados Unidos. Estou em busca de crescimento e muito foco para alcançar o que eu quero. Sei que com vocês eu posso alcançar as metas e também vou da o meu máximo para isso.
2- Eu acho que sou a pessoa que deveria escolher porque sou comprometida, tenho muita vontade de aprender e estou disposta a me dedicar de verdade para crescer nessa área. Hoje trabalho com faxina e tudo que aprendi foi aqui a cada dia me dedico para aprender e ser a melhor porque eu tenho a certeza que não quero voltar para o Brasil então vou me dedicar o máximo para construir minha vida aqui m, não  estou apenas procurando uma oportunidade, estou buscando construir uma carreira  e seguir o processo com disciplina e alcançar os meus objetivos e os de vocês.
3-   Sim, tenho capacidade de investir esse valor agora em mim mesma e entendo isso como um investimento no meu desenvolvimento e na construção da minha carreira aqui com vocês.
4- Para eu considerar essa a melhor decisão, quero estar consistente na carreira, aplicando o que aprendi no treinamento, ganhando experiência real e começando a construir resultados financeiros. Também quero me sentir mais confiante e independente profissionalmente, sabendo que estou evoluindo na direção certa.`,
      // 16:21:14 ET
      `Meta até o fim do ano: sair da limpeza e ir para o Brasil fazer uma cirurgia plástica sem ter que voltar com pressa e repagar o dinheiro que a mãe emprestou para comprar um carro.`,
    ],
  },
];

async function main() {
  console.log("\n=== Backfill notas Gustavo (caso 2026-05-14) ===\n");

  const supa = createAdminClient();
  const { data: loc } = await supa
    .from("locations")
    .select("company_id, location_name")
    .eq("location_id", GUSTAVO_LOC)
    .single();
  if (!loc?.company_id) {
    console.error("location não sincronizada");
    process.exit(1);
  }
  console.log(`Location: ${loc.location_name} (company ${loc.company_id})\n`);

  const ghl = new GHLClient(loc.company_id, GUSTAVO_LOC);

  // Idempotência defensiva: antes de criar, lê notas existentes do contato
  // e pula se já tem uma com mesmo body (caso script rode 2x).
  let totalCreated = 0;
  let totalSkipped = 0;

  for (const target of BACKFILL) {
    console.log(`\n=== ${target.contact_name} (${target.contact_id}) ===`);

    // Lê notas atuais pra dedup
    type NotesResp = { notes?: Array<{ id: string; body: string }> };
    let existingBodies = new Set<string>();
    try {
      const res = await ghl.get<NotesResp>(
        `/contacts/${target.contact_id}/notes`,
      );
      existingBodies = new Set(
        (res.notes || []).map((n) => (n.body || "").trim()),
      );
      console.log(`  Existing notes: ${existingBodies.size}`);
    } catch (err) {
      console.warn(`  ⚠️  Falha ao ler notas existentes: ${err}`);
    }

    for (let i = 0; i < target.notes.length; i++) {
      const body = target.notes[i].trim();
      const label = `nota ${i + 1}/${target.notes.length}`;
      if (existingBodies.has(body)) {
        console.log(`  ⏭  ${label} já existe — pulando`);
        totalSkipped++;
        continue;
      }
      try {
        const { noteId } = await createNoteOnContact(
          ghl,
          target.contact_id,
          body,
        );
        console.log(`  ✓ ${label} criada (id=${noteId}) — ${body.slice(0, 50)}…`);
        totalCreated++;
      } catch (err) {
        console.error(
          `  ❌ ${label} falhou:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  console.log(`\n=== RESUMO ===`);
  console.log(`Criadas: ${totalCreated}`);
  console.log(`Já existiam (skipped): ${totalSkipped}`);
  console.log(`Total esperado: 8\n`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
