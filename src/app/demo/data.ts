// SparkBot Kiosk — dados roteirizados das cenas.
// Refactor 2026-06-11 (Pedro): narrativa "na mão → por voz → sozinho" em 3 atos —
// CRM (Spark Leads) vira co-protagonista. Ato 1 = pessoa opera o CRM por toque;
// Ato 2 = mesmas ações por voz (SparkBot); Ato 3 = bot proativo. On-rails: nada
// conecta com sistema real.

export type CrmAction = "funnel-touch" | "card-touch" | "schedule" | "update-lead" | "proactive";
export type SceneKind = "touch" | "voice" | "auto";

export interface Scene {
  id: number;
  act: 1 | 2 | 3;
  kind: SceneKind;
  superpower: string;
  title: string;
  sub: string;
  /** Instrução do passo de toque (cenas kind="touch") */
  coach?: string;
  /** Helper exibido depois do toque bem-sucedido */
  successLabel?: string;
  audioTranscript: string | null;
  audioDuration?: string;
  /** Resposta do bot. Token {vocativo} vira ", Nome" quando a pessoa deu o nome. */
  botText?: string;
  crmAction: CrmAction;
}

export const ACT_LABELS: Record<1 | 2 | 3, string> = {
  1: "Ato 1 · Você no comando",
  2: "Ato 2 · Agora por voz",
  3: "Ato 3 · Ele trabalha sozinho",
};

/** Substitui {vocativo} por ", PrimeiroNome" (ou remove, se a pessoa pulou o nome). */
export function applyVocativo(text: string, name: string | null): string {
  const first = (name || "").trim().split(/\s+/)[0] || "";
  return text.replace(/\{vocativo\}/g, first ? `, ${first}` : "");
}

export const SCENES: Scene[] = [
  // ============ ATO 1 — CENA 1: funil por toque ============
  {
    id: 1,
    act: 1,
    kind: "touch",
    superpower: "Funil na mão",
    title: "O funil se move com você.",
    sub: "Cada lead é um card — etapa, valor e contato sempre à vista.",
    coach: "O João avançou na conversa: arrasta o card dele pra Proposta",
    successLabel: "Funil atualizado! É assim que o Spark Leads organiza seus leads.",
    audioTranscript: null,
    crmAction: "funnel-touch",
  },

  // ============ ATO 1 — CENA 2: ficha do contato ============
  {
    id: 2,
    act: 1,
    kind: "touch",
    superpower: "Tudo num lugar",
    title: "A ficha guarda a conversa inteira.",
    sub: "WhatsApp, notas e follow-ups dentro do CRM — nada se perde.",
    coach: "Toca na Maria Oliveira pra abrir a ficha dela",
    successLabel: "A conversa do WhatsApp tá toda aqui. E olha: o follow-up dela venceu…",
    audioTranscript: null,
    crmAction: "card-touch",
  },

  // ============ ATO 2 — CENA 3: agendar por voz ============
  {
    id: 3,
    act: 2,
    kind: "voice",
    superpower: "Agendar por voz",
    title: "Agora não toca em nada. Fala.",
    sub: "Manda um áudio — o SparkBot agenda direto no CRM que você acabou de usar.",
    audioTranscript: "Marca uma reunião com o João Silva terça às 15h sobre a renovação do seguro de vida.",
    audioDuration: "0:11",
    botText: "Pronto{vocativo}! ✓\n\n📅 *Reunião com João Silva*\nTerça-feira, 15:00 — Renovação Seguro de Vida\n\nJá lancei na sua agenda e mandei o convite no WhatsApp dele.",
    crmAction: "schedule",
  },

  // ============ ATO 2 — CENA 4: atualizar falando ============
  {
    id: 4,
    act: 2,
    kind: "voice",
    superpower: "Atualizar falando",
    title: "O que você fez com o dedo, ele faz com a sua voz.",
    sub: "Fala a atualização — o funil se move e a nota cai na ficha.",
    audioTranscript: "Atualização do João Silva: ele quer pensar até semana que vem. Manda follow-up sexta.",
    audioDuration: "0:09",
    botText: "Atualizei o João Silva ✓\n\n📝 Anotação salva na ficha\n🔄 Etapa: *Proposta* → *Em consideração*\n⏰ Follow-up agendado pra sexta, 10h",
    crmAction: "update-lead",
  },

  // ============ ATO 3 — CENA 5: proativo ============
  {
    id: 5,
    act: 3,
    kind: "auto",
    superpower: "Trabalha sozinho",
    title: "Lembra do follow-up vencido da Maria?",
    sub: "Você não pediu nada. Ele percebeu e já cuidou.",
    audioTranscript: null,
    botText: "Oi{vocativo}! Tô aqui 👋\n\nNotei que a *Maria Oliveira* não responde há 7 dias. O follow-up venceu ontem.\n\n✅ Já mandei pra ela:\n_\"Oi Maria, tudo bem? Lembrando da nossa conversa sobre o seguro pra família. Topa retomar essa semana?\"_\n\nTe aviso quando ela responder.",
    crmAction: "proactive",
  },
];

export interface PipelineStage { key: string; label: string; color: string }
export const PIPELINE_STAGES: PipelineStage[] = [
  { key: "lead",     label: "Novo",         color: "#9AA8B5" },
  { key: "contato",  label: "Contato",      color: "#6BB6FF" },
  { key: "proposta", label: "Proposta",     color: "#0FB5E1" },
  { key: "consider", label: "Consideração", color: "#FFD23F" },
  { key: "fechado",  label: "Fechado",      color: "#1DB954" },
];

export interface Contact { id: string; name: string; initials: string; stage: string; value: string; tag: string; phone: string }
export const CONTACTS: Contact[] = [
  { id: "joao", name: "João Silva", initials: "JS", stage: "proposta", value: "R$ 240.000", tag: "Renovação", phone: "+55 11 98712-4530" },
  { id: "maria", name: "Maria Oliveira", initials: "MO", stage: "contato", value: "R$ 180.000", tag: "Família", phone: "+55 11 99544-2010" },
  { id: "carlos", name: "Carlos Mendes", initials: "CM", stage: "lead", value: "—", tag: "Indicação", phone: "+55 21 98821-3344" },
  { id: "ana", name: "Ana Beatriz Costa", initials: "AB", stage: "consider", value: "R$ 320.000", tag: "Empresarial", phone: "+55 11 97712-6601" },
  { id: "rafa", name: "Rafael Lima", initials: "RL", stage: "fechado", value: "R$ 96.000", tag: "Jovem profissional", phone: "+55 31 98444-2122" },
];

// ============ Ficha da Maria (cena 2) — planta a semente da cena 5 ============
// Continuidade: último contato dela foi há 7 dias e o follow-up venceu → é
// exatamente o que o bot resolve sozinho no Ato 3.
export interface ThreadMsg { from: "lead" | "rep"; text: string; time: string }
export const MARIA_THREAD: ThreadMsg[] = [
  { from: "lead", text: "Oi! A Juliana me indicou você. Queria entender o seguro de vida pra família 🙏", time: "2 jun" },
  { from: "rep", text: "Oi Maria! Que bom 😊 Me conta: vocês são quantos em casa?", time: "2 jun" },
  { from: "lead", text: "Somos 4 — eu, meu marido e duas meninas (6 e 9).", time: "2 jun" },
  { from: "rep", text: "Perfeito. Montei duas opções de proteção pra vocês — te mando amanhã com calma!", time: "3 jun" },
  { from: "lead", text: "Combinado! 👍", time: "3 jun" },
  { from: "rep", text: "Maria, conseguiu olhar as opções que te mandei? Qualquer dúvida me chama!", time: "4 jun" },
];

export interface ContactNote { text: string; time: string; via: string }
export const MARIA_NOTES: ContactNote[] = [
  { text: "Indicação da Juliana. Foco: proteção da família (2 filhas).", time: "2 jun", via: "SparkBot" },
  { text: "Enviadas 2 propostas (Vida Família 180k / 250k). Aguardando retorno.", time: "4 jun", via: "SparkBot" },
];

export interface CalendarEvent { id: string; day: number; start: number; end: number; title: string; type: string; isNew?: boolean }
export const CALENDAR_EVENTS: CalendarEvent[] = [
  // Days: 1=Seg,2=Ter,3=Qua,4=Qui,5=Sex
  { id: "e1", day: 1, start: 9,  end: 10, title: "Onboarding Ana Costa", type: "meeting" },
  { id: "e2", day: 1, start: 14, end: 15, title: "Renovação Carlos M.", type: "meeting" },
  { id: "e3", day: 2, start: 10, end: 11, title: "Ligação Rafael L.", type: "call" },
  { id: "e4", day: 3, start: 11, end: 12, title: "Apresentação Empresarial", type: "meeting" },
  { id: "e5", day: 4, start: 9,  end: 10, title: "Follow-up semanal", type: "task" },
  { id: "e6", day: 4, start: 16, end: 17, title: "Visita cliente Tatuapé", type: "meeting" },
  { id: "e7", day: 5, start: 10, end: 11, title: "Reunião equipe", type: "internal" },
];
