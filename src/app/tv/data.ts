// TV do estande — copy e dados roteirizados das telas (fonte única pra ajustar texto).
// Tudo fake/on-rails, mesma família de dados do quiosque (/demo).

export const QR_URL = "app.sparkleads.pro";

export const HERO = {
  badge: "Convenção 2026",
  eyebrow: "Conheça o Spark Leads",
  line1: "CRM completo.",
  line2: "Operado por voz.",
  chips: ["📊 Funil visual", "📅 Agenda integrada", "💬 WhatsApp no CRM", "🎯 Follow-up sozinho"],
};

export const VOICE = {
  title1: "Você fala.",
  title2: "Ele resolve.",
  sub: "Manda um áudio no WhatsApp — o SparkBot agenda, anota e atualiza o CRM.",
  transcript: "“Marca uma reunião com o João Silva terça às 15h sobre a renovação do seguro.”",
  reply: "Pronto! ✓\n\n📅 Reunião com João Silva\nTerça-feira, 15:00\n\nJá lancei na sua agenda e mandei o convite no WhatsApp dele.",
  pill: "📅 Reunião lançada na agenda",
};

export const FUNNEL = {
  title: "O funil se move sozinho.",
  sub: "Você fala a atualização — o lead muda de etapa.",
  stages: [
    { key: "novo", label: "Novo", color: "#9AA8B5", cards: [{ n: "Carlos Mendes", i: "CM", v: "—", t: "Indicação" }] },
    { key: "contato", label: "Contato", color: "#6BB6FF", cards: [{ n: "Maria Oliveira", i: "MO", v: "R$ 180.000", t: "Família" }] },
    { key: "proposta", label: "Proposta", color: "#2BD4FF", cards: [] },
    { key: "consider", label: "Consideração", color: "#FFD23F", cards: [{ n: "Ana Costa", i: "AB", v: "R$ 320.000", t: "Empresarial" }] },
    { key: "fechado", label: "Fechado", color: "#34E27A", cards: [{ n: "Rafael Lima", i: "RL", v: "R$ 96.000", t: "Jovem" }] },
  ],
  mover: { n: "João Silva", i: "JS", v: "R$ 240.000", t: "Renovação" },
  totalLabel: "no funil",
  total: 836000,
};

export const AGENDA = {
  title: "Agenda cheia. Sem digitar.",
  sub: "Cada áudio vira reunião confirmada — convite direto no WhatsApp do cliente.",
  days: ["Seg", "Ter", "Qua", "Qui", "Sex"],
  // col 0-4, row 0-4 (slots de hora 9-17 simplificados), delay = ordem do ping
  events: [
    { day: 0, row: 0, len: 1, title: "Onboarding Ana", color: "#2BD4FF" },
    { day: 2, row: 1, len: 1, title: "Apresentação Empresarial", color: "#2BD4FF" },
    { day: 1, row: 0, len: 1, title: "Ligação Rafael", color: "#FFA45C" },
    { day: 3, row: 0, len: 1, title: "Follow-up semanal", color: "#B28BFF" },
    { day: 0, row: 3, len: 1, title: "Renovação Carlos", color: "#2BD4FF" },
    { day: 4, row: 1, len: 1, title: "Reunião de equipe", color: "#9AA8B5" },
    { day: 3, row: 4, len: 1, title: "Visita Tatuapé", color: "#2BD4FF" },
  ],
  newEvent: { day: 1, row: 3, len: 1, title: "João Silva — Renovação", time: "15:00" },
  pill: "✓ Convite enviado no WhatsApp do cliente",
};

export const PROACTIVE = {
  title: "Ele trabalha enquanto você atende.",
  sub: "O SparkBot percebe o lead esfriando e age sozinho.",
  alert: { name: "Maria Oliveira esfriou", detail: "7 dias sem resposta · follow-up venceu ontem" },
  message: "“Oi Maria, tudo bem? Lembrando da nossa conversa sobre o seguro pra família. Topa retomar essa semana?”",
  sentAt: "✓ Follow-up enviado às 09:42 — sem ninguém pedir",
  feed: [
    { icon: "🤖", text: "Follow-up enviado pra Maria Oliveira", time: "agora" },
    { icon: "📅", text: "Reunião criada: João Silva, terça 15h", time: "há 4 min" },
    { icon: "📝", text: "Ficha do João atualizada por áudio", time: "há 5 min" },
    { icon: "💬", text: "Carlos Mendes respondeu no WhatsApp", time: "há 1h" },
  ],
};

export const WHY = {
  eyebrow: "Por que Spark Leads",
  title: "Tudo que a sua operação precisa. Num lugar só.",
  props: [
    { icon: "📊", title: "Funil visual", sub: "Cada lead é um card — etapa, valor e contato à vista." },
    { icon: "💬", title: "WhatsApp no CRM", sub: "A conversa inteira na ficha. Nada se perde." },
    { icon: "🎙️", title: "Copiloto de voz", sub: "Manda áudio — ele agenda, anota e atualiza." },
    { icon: "🎯", title: "Follow-up sozinho", sub: "Lead esfriou? Ele percebe e já cuida." },
  ],
};

export const CTA = {
  title1: "Vem ver ao vivo.",
  sub: "Faz a demonstração no tablet aqui do estande 👉",
  qrLabel: "Ou aponta a câmera",
};
