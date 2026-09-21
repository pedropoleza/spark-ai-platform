/**
 * Espelho do company token do Spark Leads no banco PRINCIPAL (H93, 2026-09-21).
 *
 * O token OAuth sempre morou num Supabase SEPARADO (projeto "GHL Token",
 * compartilhado com outros apps). Esse projeto colapsou em 19-21/09 — leituras
 * estourando timeout por minutos, `could not accept SSL connection`, transação
 * abortada — e levou a plataforma inteira junto, porque sem company token não se
 * gera location token e NADA fala com o CRM (36h de apagão).
 *
 * Duas consequências, as duas resolvidas aqui:
 *
 *   LEITURA — a plataforma não pode cair junto com aquele projeto. O caminho
 *   quente lê DAQUI (banco principal, saudável) e só cai pro original quando o
 *   espelho ainda não existe, fazendo backfill na passagem.
 *
 *   ESCRITA — o refresh_token do GHL é de USO ÚNICO: o GHL rotaciona no refresh
 *   e, se a gravação de volta falha, o par novo se perde e a tabela fica com um
 *   token MORTO, recuperável só re-autorizando o app à mão. Foi exatamente o que
 *   aconteceu. Por isso grava-se AQUI PRIMEIRO — a rotação nunca mais depende do
 *   projeto doente.
 *
 * A "Token Refresher" original continua sendo escrita (best-effort) porque há
 * outros consumidores lendo dela.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export interface TokenEmpresa {
  access_token: string;
  refresh_token: string;
  token_type?: string | null;
  expires_in?: number | null;
  scope?: string | null;
  userType?: string | null;
  userId?: string | null;
  refreshTokenId?: string | null;
  isBulkInstallation?: string | null;
  updated_at?: string | null;
}

/** Lê o par do espelho. `null` = ainda não espelhado (não é erro). */
export async function lerTokenEspelho(companyId: string): Promise<TokenEmpresa | null> {
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("ghl_company_tokens")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    scope: data.scope,
    userType: data.user_type,
    userId: data.user_id,
    refreshTokenId: data.refresh_token_id,
    isBulkInstallation: data.is_bulk_installation,
    updated_at: data.updated_at,
  };
}

/**
 * Grava o par no espelho. LANÇA em falha de propósito: este é o write que
 * protege a rotação — se ele não passou, o chamador precisa saber antes de
 * considerar o refresh concluído.
 *
 * `somenteSeMaisNovo` é pro BACKFILL (cópia vinda da tabela antiga): ali o par
 * pode estar ATRASADO em relação ao que já está no espelho, e sobrescrever é
 * destrutivo de um jeito silencioso.
 *
 * Incidente que criou esta trava (2026-09-21): uma sessão renovou o token e
 * gravou o par novo direto no espelho; meia hora depois um backfill copiou a
 * linha da tabela antiga por cima. O access_token velho ainda era válido, então
 * NADA quebrou na hora — mas o refresh_token que veio junto já tinha sido
 * CONSUMIDO na renovação (uso único), e o estrago só apareceria na renovação
 * seguinte, horas depois. Espelho nunca anda pra trás.
 */
export async function gravarTokenEspelho(
  companyId: string,
  t: TokenEmpresa,
  opts: { somenteSeMaisNovo?: boolean } = {},
): Promise<void> {
  const sb = createAdminClient();

  if (opts.somenteSeMaisNovo) {
    const atual = await lerTokenEspelho(companyId).catch(() => null);
    const tAtual = atual?.updated_at ? Date.parse(atual.updated_at) : NaN;
    const tNovo = t.updated_at ? Date.parse(t.updated_at) : Date.now();
    if (!Number.isNaN(tAtual) && tAtual >= tNovo) {
      console.warn(
        `[GHL] backfill ignorado (company=${companyId}): o espelho já tem par igual ou mais novo`,
      );
      return;
    }
  }
  const { error } = await sb.from("ghl_company_tokens").upsert(
    {
      company_id: companyId,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: t.token_type ?? null,
      expires_in: t.expires_in ?? null,
      scope: t.scope ?? null,
      user_type: t.userType ?? "Company",
      user_id: t.userId ?? null,
      refresh_token_id: t.refreshTokenId ?? null,
      is_bulk_installation: t.isBulkInstallation ?? null,
      // Momento da EMISSÃO do par (não é touch de linha): é o que
      // isCompanyTokenNearExpiry cruza com expires_in.
      updated_at: t.updated_at ?? new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );
  if (error) throw new Error(`espelho do company token falhou: ${error.message}`);
}

/** Lista os companyIds espelhados (usado pelo cron de renovação). */
export async function listarCompaniesEspelhadas(): Promise<
  Array<{ companyId: string; refresh_token: string }>
> {
  const sb = createAdminClient();
  const { data, error } = await sb.from("ghl_company_tokens").select("company_id, refresh_token");
  if (error || !data) return [];
  return data.map((r) => ({ companyId: r.company_id as string, refresh_token: r.refresh_token as string }));
}
