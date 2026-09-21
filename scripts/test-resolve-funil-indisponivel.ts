/**
 * H94 — "não consegui ler" não pode virar "não existe".
 *
 * O `resolvePipelineStage` engolia a exceção do GHL e devolvia null; os três
 * chamadores traduzem null em «funil/etapa não existe na location». Durante o
 * apagão de token de 19-21/09 isso saiu 15× na conta da Marina, afirmando que
 * um funil que EXISTE não existia. Mesma classe do H93.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, det = "") => {
  if (cond) { ok++; console.log(`  PASS  ${nome}`); }
  else { fail++; console.log(`  FALHA ${nome} ${det}`); }
};

const FUNIS = {
  pipelines: [{
    id: "pipe-1", name: "1- Prospects (Social Selling)",
    stages: [{ id: "st-1", name: "Contato" }, { id: "st-2", name: "Qualificado" }],
  }],
};

(async () => {
  const { resolvePipelineStage } = await import("../src/lib/ghl/operations");
  type Cli = Parameters<typeof resolvePipelineStage>[0];

  const clienteOk = { get: async () => FUNIS } as unknown as Cli;
  const clienteFora = {
    get: async () => { throw new Error('401 - {"statusCode":401,"message":"Invalid JWT"}'); },
  } as unknown as Cli;

  console.log("\n=== CRM respondendo ===");
  const achou = await resolvePipelineStage(clienteOk, "LOC", "1- Prospects (Social Selling)", "Contato");
  t("acha por nome exato", achou?.pipelineId === "pipe-1" && achou?.stageId === "st-1", JSON.stringify(achou));

  const naoAchou = await resolvePipelineStage(clienteOk, "LOC", "Funil Que Nao Existe", "Contato");
  t("funil inexistente devolve null (é 'procurei e não achei')", naoAchou === null, JSON.stringify(naoAchou));

  const etapaNaoAchou = await resolvePipelineStage(clienteOk, "LOC", "1- Prospects (Social Selling)", "Etapa Fantasma");
  t("etapa inexistente devolve null", etapaNaoAchou === null, JSON.stringify(etapaNaoAchou));

  console.log("\n=== CRM FORA (o caso do apagão) ===");
  let erro: Error | null = null;
  let devolveu: unknown = "NAO_CHAMOU";
  try { devolveu = await resolvePipelineStage(clienteFora, "LOC", "1- Prospects (Social Selling)", "Contato"); }
  catch (e) { erro = e as Error; }

  t("NÃO devolve null quando a leitura falha", devolveu === "NAO_CHAMOU", `devolveu=${JSON.stringify(devolveu)}`);
  t("lança erro", erro !== null);
  t("erro NÃO afirma que o funil não existe", !!erro && !/não existe/i.test(erro.message), erro?.message);
  t("erro diz que não conseguiu LER", !!erro && /não consegui ler/i.test(erro.message), erro?.message);
  t("erro preserva a causa original (401)", !!erro && /401|Invalid JWT/.test(erro.message), erro?.message);

  console.log(`\n${ok}/${ok + fail} passaram`);
  process.exit(fail ? 1 : 0);
})();
