-- H93 (2026-09-21) — espelho do company token do Spark Leads no banco PRINCIPAL.
--
-- POR QUÊ: o token OAuth mora num Supabase SEPARADO (projeto "GHL Token",
-- compartilhado com outros apps). Esse projeto entrou em colapso: leituras
-- estourando timeout por minutos seguidos, `could not accept SSL connection`,
-- transação abortada. Consequência dupla:
--
--   1) LEITURA: sem o company token não se gera location token, e NADA fala com
--      o CRM. 36h de apagão em 19-20/09 por causa disso.
--   2) ESCRITA: o refresh_token do GHL é de USO ÚNICO. Se o GHL rotaciona e a
--      gravação de volta falha, o par novo se perde e a tabela fica com um token
--      MORTO — recuperável só re-autorizando o app à mão. Foi exatamente o que
--      aconteceu.
--
-- Este espelho vive no banco principal (saudável) e vira a fonte do caminho
-- quente: grava-se AQUI PRIMEIRO (a rotação nunca mais se perde) e lê-se AQUI
-- PRIMEIRO (a plataforma não cai junto com o outro projeto). A "Token Refresher"
-- original continua sendo escrita, porque há outros consumidores lendo dela.
create table if not exists ghl_company_tokens (
  company_id      text primary key,
  access_token    text not null,
  refresh_token   text not null,
  token_type      text,
  expires_in      integer,
  scope           text,
  user_type       text,
  user_id         text,
  refresh_token_id text,
  is_bulk_installation text,
  -- quando o par foi emitido (NÃO é o touch da linha): é o que
  -- `isCompanyTokenNearExpiry` usa junto com expires_in pra decidir renovação.
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table ghl_company_tokens is
  'Espelho do company token OAuth do Spark Leads (H93). Fonte do caminho quente; a "Token Refresher" do projeto GHL Token segue espelhada pra outros consumidores.';

alter table ghl_company_tokens enable row level security;
-- Sem policy: só a service_role (que bypassa RLS) toca nisso. Token de agência
-- não pode ser legível por client key em hipótese nenhuma.
