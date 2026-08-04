/**
 * Auditoria de dia-da-semana errado nas mensagens dos agentes (H68).
 *
 * Mede a taxa de erro que originou o H68: o modelo mapeava dia-da-semana ↔ data
 * pelo calendário do ANO DE TREINO (2025), não pelo corrente. Antes do fix:
 * SparkBot 66/401 (16,5%) e lead-facing 7/84 (8,3%) em 21 dias — com 73 de 73
 * erros batendo exatamente com 2025.
 *
 * Serve como CANÁRIO: rode depois do deploy pra confirmar que a taxa caiu (e
 * pra pegar se voltar quando o ano virar, ou quando trocarmos de modelo).
 *
 * O weekday real é calculado NO POSTGRES (`extract(dow from make_date(...))`).
 * Não use LLM pra auditar calendário — o auditor cai no mesmo erro do auditado.
 *
 *   npx tsx -r tsconfig-paths/register scripts/audit-weekday-drift.ts [dias]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const DIAS = Number(process.argv[2] || 21);

const SQL = `
with sb as (
  select 'SparkBot (rep)' as lado, m.id::text as id, m.rep_id::text as ator, m.created_at,
         (regexp_matches(lower(translate(m.content,'áàâãéêíóôõúç','aaaaeeiooouc')),
           '(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?[,]?\\s+(?:dia\\s+)?(\\d{1,2})/(\\d{1,2})','g')) as m3
  from sparkbot_messages m
  where m.role='agent' and m.created_at > now() - interval '${DIAS} days'
), lf as (
  select 'Lead-facing' as lado, e.id::text as id, e.agent_id::text as ator, e.created_at,
         (regexp_matches(lower(translate(coalesce(e.action_payload->>'message',''),'áàâãéêíóôõúç','aaaaeeiooouc')),
           '(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?[,]?\\s+(?:dia\\s+)?(\\d{1,2})/(\\d{1,2})','g')) as m3
  from execution_log e
  where e.action_type in ('send_message','send_error_message') and e.created_at > now() - interval '${DIAS} days'
), tudo as (
  select * from sb union all select * from lf
), avaliado as (
  select lado, ator, created_at,
    (case m3[1] when 'domingo' then 0 when 'segunda' then 1 when 'terca' then 2 when 'quarta' then 3
      when 'quinta' then 4 when 'sexta' then 5 when 'sabado' then 6 end) as dito,
    extract(dow from make_date(extract(year from created_at)::int, m3[3]::int, m3[2]::int))::int as real_ano_corrente,
    extract(dow from make_date(extract(year from created_at)::int - 1, m3[3]::int, m3[2]::int))::int as real_ano_anterior
  from tudo
  where m3[3]::int between 1 and 12 and m3[2]::int between 1 and 31
)
select lado,
  count(*) as pares,
  count(*) filter (where dito <> real_ano_corrente) as errados,
  count(distinct ator) filter (where dito <> real_ano_corrente) as atores,
  count(*) filter (where dito <> real_ano_corrente and dito = real_ano_anterior) as batem_ano_anterior
from avaliado group by lado order by lado;
`;

async function main() {
  const db = createAdminClient();
  const { data, error } = await db.rpc("exec_sql", { sql: SQL }).then(
    (r) => r as { data: unknown; error: unknown },
    () => ({ data: null, error: "rpc exec_sql indisponível" }),
  );
  if (error || !data) {
    console.log(
      "Sem RPC de SQL cru neste projeto — rode a query abaixo direto no Supabase " +
        "(SQL editor ou MCP) e compare com a linha de base do H68:\n",
    );
    console.log(SQL);
    console.log(
      "\nLinha de base ANTES do fix (21 dias até 2026-08-04):\n" +
        "  SparkBot (rep) ... 401 pares · 66 errados (16,5%) · 17 reps · 66 batem com 2025\n" +
        "  Lead-facing ...... 84 pares ·  7 errados (8,3%)  ·  3 agentes · 7 batem com 2025\n" +
        "\nSe 'batem_ano_anterior' continuar ≈ 'errados', o modelo voltou a usar o calendário " +
        "do ano de treino — reveja se o bloco [CALENDÁRIO REAL] ainda está no runtime context.",
    );
    return;
  }
  console.table(data);
}

main().catch((e) => {
  console.error("FALHOU:", e);
  process.exit(1);
});
