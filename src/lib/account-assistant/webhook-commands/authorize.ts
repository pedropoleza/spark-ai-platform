/**
 * Autorização do comando via webhook (H71, Pedro 2026-08-05).
 *
 * O webhook sai de DENTRO de uma sub-conta do Spark Leads, e é isso que dá
 * a camada de confiança: o payload carrega o `location_id`. Três travas, em
 * ordem, e nenhuma delas é opcional:
 *
 *   1. SEGREDO (quando configurado) — `SPARKBOT_COMMAND_SECRET`. O location
 *      id sozinho NÃO é segredo: ele aparece em URL do painel, em link de
 *      formulário, em print de tela. Vale como "de qual conta veio", não como
 *      "quem mandou é autorizado". Com o segredo setado, a trava vira real.
 *   2. LOCATION CONHECIDA — o id tem que existir em `locations` (as contas
 *      que a agência administra). Location desconhecida = 403.
 *   3. TELEFONE DENTRO DA LOCATION — o número de destino tem que ser de um
 *      corretor que trabalha NAQUELA sub-conta (regra pedida pelo Pedro).
 *      Sem isso, qualquer conta poderia mandar aviso pro corretor de outra.
 *
 * Fora as travas, o consentimento: só recebe comando externo o corretor que
 * ACEITOU os termos. Recusa explícita barra, e pendência também — enquanto o
 * aceite não existe, o processor lê o próximo inbound como resposta ao gate
 * de termos, e um "ok" arrancado por um aviso não solicitado viraria
 * consentimento que a pessoa nunca deu (LGPD). Detalhe na trava 4.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { generatePhoneCandidates } from "@/lib/account-assistant/identity";
import type { RepIdentity } from "@/types/account-assistant";

export interface AuthorizedTarget {
  rep: RepIdentity;
  /** Location que MANDOU o webhook (onde as tools do modo prompt rodam). */
  locationId: string;
  companyId: string;
  locationName: string | null;
  locationTimezone: string | null;
}

export type AuthorizeResult =
  | { ok: true; target: AuthorizedTarget }
  | {
      ok: false;
      httpStatus: number;
      reason: string;
      detail: string;
      /**
       * Motivo PRECISO pra auditoria, quando a resposta pública é de
       * propósito mais vaga que a verdade. Ver `telefone_fora_da_location`.
       */
      auditReason?: string;
      auditDetail?: string;
    };

/**
 * Segredo compartilhado. Enquanto `SPARKBOT_COMMAND_SECRET` não existir no
 * ambiente, a checagem passa (a trava fica sendo location + telefone). Assim
 * o Pedro consegue testar antes de decidir o segredo, sem endpoint aberto
 * pra qualquer telefone: as travas 2 e 3 seguem valendo sempre.
 */
export function verificarSegredo(
  segredoHeader: string | null,
  segredoBody: string | null,
): { ok: true } | { ok: false; reason: string; detail: string } {
  const esperado = process.env.SPARKBOT_COMMAND_SECRET?.trim();
  if (!esperado) return { ok: true };

  const recebido = (segredoHeader || segredoBody || "").trim();
  if (!recebido) {
    return {
      ok: false,
      reason: "segredo_ausente",
      detail:
        "Esta plataforma exige segredo no comando. Manda no header `x-spark-secret` " +
        "ou num campo `secret` do custom data.",
    };
  }
  if (!comparacaoConstante(recebido, esperado)) {
    return { ok: false, reason: "segredo_invalido", detail: "Segredo do comando não confere." };
  }
  return { ok: true };
}

/**
 * Comparação de tempo constante. Com `!==` cru, o tempo de resposta vaza o
 * tamanho do prefixo correto — dá pra descobrir o segredo caractere a
 * caractere. Barato de evitar.
 */
function comparacaoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide se o corretor atende a location que mandou o webhook.
 * Exportada pura pra ser testável sem banco.
 */
export function repAtendeLocation(
  rep: Pick<RepIdentity, "active_location_id" | "ghl_users">,
  locationId: string,
): boolean {
  if (rep.active_location_id === locationId) return true;
  const vinculos = Array.isArray(rep.ghl_users) ? rep.ghl_users : [];
  return vinculos.some((u) => u?.location_id === locationId);
}

/**
 * Candidatos de telefone pra achar o corretor.
 *
 * `generatePhoneCandidates` cobre o que a IA coleta de lead, mas erra o
 * formato que um humano digita num custom data: `17867717077` (11 dígitos,
 * EUA com DDI e sem o `+`) vira `+5517867717077` e `+117867717077` — nenhum
 * dos dois existe. O corretor certo nunca era achado, e a resposta ainda
 * culpava a location errada. Aqui a gente ACRESCENTA o E.164 literal dos
 * dígitos; ampliar a BUSCA é seguro porque quem autoriza é a regra da
 * location logo abaixo, não o formato do número.
 */
export function candidatosDeTelefone(bruto: string): string[] {
  const base = generatePhoneCandidates(bruto);
  const digitos = (bruto || "").replace(/\D/g, "");
  const extra = digitos.length >= 10 && digitos.length <= 15 ? [`+${digitos}`] : [];
  return [...new Set([...base, ...extra])];
}

export async function authorizeCommand(args: {
  locationId: string;
  sendTo: string;
  segredoHeader: string | null;
  segredoBody: string | null;
}): Promise<AuthorizeResult> {
  // ── Trava 1: segredo ──────────────────────────────────────────────────
  const segredo = verificarSegredo(args.segredoHeader, args.segredoBody);
  if (!segredo.ok) {
    return { ok: false, httpStatus: 401, reason: segredo.reason, detail: segredo.detail };
  }

  const supabase = createAdminClient();

  // ── Trava 2: location conhecida ───────────────────────────────────────
  const { data: location, error: erroLocation } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone")
    .eq("location_id", args.locationId)
    .maybeSingle();

  if (erroLocation) {
    // Falha de infra ≠ negação. Devolvemos 503 pra automação poder repetir
    // em vez de o Pedro achar que a conta dele "não está cadastrada".
    return {
      ok: false,
      httpStatus: 503,
      reason: "erro_consulta_location",
      detail: `Não consegui consultar a sub-conta agora: ${erroLocation.message}`,
    };
  }
  if (!location) {
    return {
      ok: false,
      httpStatus: 403,
      reason: "location_desconhecida",
      detail:
        `A sub-conta ${args.locationId} não está cadastrada nesta plataforma. ` +
        "Confere se o webhook saiu da conta certa.",
    };
  }

  // ── Trava 3: telefone pertence a um corretor DESTA location ───────────
  // Mesma escada de candidatos do identify (BR/US sem `+`), pra o Pedro
  // poder digitar o número como quiser no custom data.
  const candidatos = candidatosDeTelefone(args.sendTo);
  if (candidatos.length === 0) {
    return {
      ok: false,
      httpStatus: 400,
      reason: "destino_invalido",
      detail: `"${args.sendTo}" não parece um telefone.`,
    };
  }

  const { data: reps, error: erroRep } = await supabase
    .from("rep_identities")
    .select("*")
    .in("phone", candidatos);

  if (erroRep) {
    return {
      ok: false,
      httpStatus: 503,
      reason: "erro_consulta_rep",
      detail: `Não consegui consultar o corretor agora: ${erroRep.message}`,
    };
  }

  const encontrados = (reps || []) as RepIdentity[];

  // Com mais de um candidato de telefone (mesmo número lido como BR e como
  // US), prioriza quem atende a location — é a leitura correta do número.
  const rep = encontrados.find((r) => repAtendeLocation(r, args.locationId));
  if (!rep) {
    // "não existe corretor nenhum com esse número" e "existe, mas é de outra
    // conta" são a MESMA resposta de propósito. Separadas, o endpoint vira um
    // oráculo: com um location id (que não é segredo) dava pra varrer números
    // e descobrir quem é corretor em QUALQUER conta da plataforma. O motivo
    // preciso vai pra auditoria, que só nós lemos.
    const existeNoutraConta = encontrados.length > 0;
    return {
      ok: false,
      httpStatus: 403,
      reason: "telefone_fora_da_location",
      detail:
        `O telefone ${args.sendTo} não é de um corretor desta sub-conta. Pode ser número ` +
        "errado, ou pode ser corretor de outra conta — de qualquer forma, um comando só " +
        "avisa corretor da própria conta. Se o número está certo, confere se essa pessoa " +
        "já conversou com o SparkBot pelo menos uma vez.",
      auditReason: existeNoutraConta ? "telefone_de_outra_location" : "corretor_nao_encontrado",
      auditDetail: existeNoutraConta
        ? `Telefone existe (${encontrados.length} cadastro(s)) mas nenhum atende ${args.locationId}.`
        : `Nenhum rep_identities com o telefone ${args.sendTo}.`,
    };
  }

  // ── Consentimento ─────────────────────────────────────────────────────
  if (rep.terms_rejected_at) {
    return {
      ok: false,
      httpStatus: 403,
      reason: "termos_recusados",
      detail:
        `O corretor ${rep.display_name || args.sendTo} recusou os termos do SparkBot — ` +
        "não recebe mensagem automática enquanto isso não for revertido.",
    };
  }

  /**
   * Termos PENDENTES também barram — e o motivo não é formalidade.
   *
   * Enquanto `terms_accepted_at` é nulo, o processor trata o próximo inbound
   * do corretor como resposta AO GATE DE TERMOS, e `parseTermsResponse`
   * aceita "ok", "beleza", "blz" e até "👍" como consentimento. Ou seja: um
   * comando externo não solicitado ("Lead novo do João, liga agora") que
   * arranque um "ok" do corretor registraria o aceite dos termos que ele
   * nunca leu. Consentimento fabricado por uma mensagem que a pessoa não
   * pediu é exatamente o que a LGPD não admite.
   *
   * Todo o resto do proativo já exige o aceite (`task-reminders.ts` checa
   * `terms_accepted_at` junto com o inbound). Medido antes de ligar: dos 247
   * reps, só 2 têm opt-in de WhatsApp sem aceite registrado — o custo do
   * bloqueio é ínfimo perto de gravar aceite falso.
   */
  if (!rep.terms_accepted_at) {
    return {
      ok: false,
      httpStatus: 403,
      reason: "termos_pendentes",
      detail:
        `O corretor ${rep.display_name || args.sendTo} ainda não aceitou os termos do SparkBot. ` +
        "Ele precisa responder o aceite numa conversa que ELE começou — até lá, comando externo " +
        "não vale como consentimento.",
    };
  }

  return {
    ok: true,
    target: {
      rep,
      locationId: location.location_id,
      companyId: location.company_id,
      locationName: location.location_name ?? null,
      locationTimezone: location.timezone ?? null,
    },
  };
}
