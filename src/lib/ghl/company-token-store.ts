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


/**
 * Instante de EMISSÃO do par, lido do `iat` do próprio access_token.
 *
 * É o carimbo autoritativo: vem assinado pelo GHL e não depende de quem gravou
 * a linha. O `updated_at` NÃO serve sozinho — quem re-semeia a partir da tabela
 * antiga copia o carimbo da ORIGEM, então a coluna descreve o par, não a
 * escrita, e duas fontes com convenções diferentes se comparam errado.
 * (Crédito do achado: sessão irmã, incidente de 2026-09-21.)
 */
function emissaoDoPar(t: TokenEmpresa): number | null {
  const parte = t.access_token?.split(".")[1];
  if (!parte) return null;
  try {
    const payload = JSON.parse(Buffer.from(parte, "base64").toString());
    return typeof payload?.iat === "number" ? payload.iat * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * `candidato` é estritamente mais novo que `atual`?
 * Empate = NÃO (mesmo par; reescrever não agrega e só arrisca).
 * Sem `iat` legível dos dois lados, cai pro `updated_at`; sem nenhum dos dois,
 * recusa — na dúvida, preserva o que já está gravado.
 */
function ehMaisNovo(candidato: TokenEmpresa, atual: TokenEmpresa): boolean {
  const iatNovo = emissaoDoPar(candidato);
  const iatAtual = emissaoDoPar(atual);
  if (iatNovo !== null && iatAtual !== null) return iatNovo > iatAtual;

  const tNovo = candidato.updated_at ? Date.parse(candidato.updated_at) : NaN;
  const tAtual = atual.updated_at ? Date.parse(atual.updated_at) : NaN;
  if (!Number.isNaN(tNovo) && !Number.isNaN(tAtual)) return tNovo > tAtual;
  return false;
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
    if (atual && !ehMaisNovo(t, atual)) {
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
