/**
 * Formulário do lead no contexto do agente (H114, caso Alves Cury 03/11/2026).
 *
 * A Âna preencheu "Aposentadoria e Planejamento Financeiro" no Facebook e
 * respondeu "Planejar minha aposentadoria" e "De 10 a 20 anos". Ela nunca
 * escreveu no WhatsApp, então a IA abriu só com o gatilho e, sem saber o tema,
 * falou de "proteção financeira" (seguro). Os dados estavam no contato o tempo
 * todo: o nome do formulário em `lastAttributionSource`/`attributionSource` e as
 * respostas em campos personalizados cujo NOME é a pergunta do formulário. O
 * histórico do lead que vai ao prompt mostrava etiquetas, oportunidades,
 * mensagens e notas, mas não isso.
 *
 * Puro e testável: recebe o contato e o mapa id → nome dos campos da conta.
 */

export interface FormularioDoLead {
  /** Nome do formulário (ex.: "Aposentadoria e Planejamento Financeiro - Form"). */
  nome?: string;
  /** Campanha do anúncio. */
  campanha?: string;
  /** Conteúdo/criativo do anúncio (utm_content). */
  conteudo?: string;
  /** Perguntas do formulário com a resposta do lead. */
  respostas: Array<{ pergunta: string; resposta: string }>;
}

type Atribuicao = Record<string, unknown> | null | undefined;

export interface ContatoComFormulario {
  attributionSource?: Atribuicao;
  lastAttributionSource?: Atribuicao;
  customFields?: Array<{ id?: string; value?: unknown }>;
  customField?: Array<{ id?: string; value?: unknown }>;
}

const MAX_RESPOSTAS = 8;
const MAX_TEXTO = 160;

function texto(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(texto).filter(Boolean).join(", ");
  return String(v).replace(/\s+/g, " ").trim();
}

function primeiro(fontes: Atribuicao[], ...chaves: string[]): string | undefined {
  for (const f of fontes) {
    if (!f || typeof f !== "object") continue;
    for (const k of chaves) {
      const v = texto((f as Record<string, unknown>)[k]);
      if (v) return v.slice(0, MAX_TEXTO);
    }
  }
  return undefined;
}

/** Nome de campo que é pergunta de formulário ("Qual é o seu principal objetivo?"). */
export function ehPerguntaDeFormulario(nome: string): boolean {
  return /\?\s*$/.test(nome.trim()) && nome.trim().length >= 8;
}

export function extrairFormularioDoLead(
  contato: ContatoComFormulario | null | undefined,
  nomesDosCampos: ReadonlyMap<string, string>,
): FormularioDoLead | null {
  if (!contato) return null;
  // A atribuição MAIS RECENTE manda: o lead antigo que preencheu outro formulário
  // agora (Izolismaria: abril pelo WhatsApp, novembro pelo formulário de
  // aposentadoria) é atendido pelo assunto de agora.
  const fontes: Atribuicao[] = [contato.lastAttributionSource, contato.attributionSource];
  const nome = primeiro(fontes, "formName");
  const campanha = primeiro(fontes, "campaign", "utmCampaign");
  const conteudo = primeiro(fontes, "utmContent");

  const respostas: Array<{ pergunta: string; resposta: string }> = [];
  const campos = contato.customFields || contato.customField || [];
  for (const c of Array.isArray(campos) ? campos : []) {
    if (respostas.length >= MAX_RESPOSTAS) break;
    const pergunta = c?.id ? nomesDosCampos.get(c.id) : undefined;
    if (!pergunta || !ehPerguntaDeFormulario(pergunta)) continue;
    const resposta = texto(c.value).slice(0, MAX_TEXTO);
    if (!resposta) continue;
    respostas.push({ pergunta: pergunta.trim().slice(0, MAX_TEXTO), resposta });
  }

  if (!nome && !campanha && !conteudo && respostas.length === 0) return null;
  return { nome, campanha, conteudo, respostas };
}
