// SparkBot Kiosk — dados roteirizados das cenas (handoff Claude Design).
// On-rails: nada conecta com sistema real.

export type CrmAction = "schedule" | "update-lead" | "knowledge" | "proactive";

export interface BotStep {
  type: "typing" | "msg" | "proactive-msg";
  delay: number;
  text?: string;
}

export interface Scene {
  id: number;
  superpower: string;
  title: string;
  sub: string;
  audioTranscript: string | null;
  audioDuration?: string;
  botSteps: BotStep[];
  crmAction: CrmAction;
}

export const SCENES: Scene[] = [
  // ============ CENA 1 — Agendar por voz ============
  {
    id: 1,
    superpower: "Agendar por voz",
    title: "Você fala. A agenda se preenche.",
    sub: "Sem abrir CRM, sem digitar nada — só fala.",
    audioTranscript: "Marca uma reunião com o João Silva terça às 15h sobre a renovação do seguro de vida.",
    audioDuration: "0:11",
    botSteps: [
      { type: "typing", delay: 600 },
      { type: "msg", delay: 1200, text: "Pronto! ✓\n\n📅 *Reunião com João Silva*\nTerça-feira, 15:00 — Renovação Seguro de Vida\n\nJá lancei na sua agenda e mandei o convite no WhatsApp dele." },
    ],
    crmAction: "schedule",
  },

  // ============ CENA 2 — Atualizar o lead falando ============
  {
    id: 2,
    superpower: "Atualizar o lead falando",
    title: "Fala a atualização. O funil se move.",
    sub: "A ficha do contato muda na sua frente.",
    audioTranscript: "Atualização do João Silva: ele quer pensar até semana que vem. Manda follow-up sexta.",
    audioDuration: "0:09",
    botSteps: [
      { type: "typing", delay: 600 },
      { type: "msg", delay: 1100, text: "Atualizei o João Silva ✓\n\n📝 Anotação salva na ficha\n🔄 Etapa: *Proposta* → *Em consideração*\n⏰ Follow-up agendado pra sexta, 10h" },
    ],
    crmAction: "update-lead",
  },

  // ============ CENA 3 — Especialista no bolso ============
  {
    id: 3,
    superpower: "Especialista no bolso",
    title: "Pergunta técnica? Resposta na hora.",
    sub: "Conhecimento do mercado de seguro de vida sempre com você.",
    audioTranscript: "Cliente diabético tipo 2, 47 anos. Qual a melhor opção de seguro de vida pra ele?",
    audioDuration: "0:08",
    botSteps: [
      { type: "typing", delay: 700 },
      { type: "msg", delay: 1300, text: "Pra esse perfil tenho 3 caminhos que costumam funcionar 👇" },
    ],
    crmAction: "knowledge",
  },

  // ============ CENA 4 — Trabalha por você ============
  {
    id: 4,
    superpower: "Trabalha por você",
    title: "Enquanto você atende, ele age sozinho.",
    sub: "Proativo: identifica o que esfriou e já cuida.",
    audioTranscript: null, // não tem áudio do usuário — bot age sozinho
    botSteps: [
      { type: "proactive-msg", delay: 800, text: "Oi! Tô aqui 👋\n\nNotei que a *Maria Oliveira* não responde há 7 dias. O follow-up venceu ontem.\n\n✅ Já mandei pra ela:\n_\"Oi Maria, tudo bem? Lembrando da nossa conversa sobre o seguro pra família. Topa retomar essa semana?\"_\n\nTe aviso quando ela responder." },
    ],
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
