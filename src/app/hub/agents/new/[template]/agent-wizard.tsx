"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, Send, Sparkles, Check, Mic, Square, Pencil, SkipForward } from "lucide-react";
import { AMark, ChannelChip } from "@/components/hub/primitives";
import { MODULE_LABEL } from "@/components/hub/module-labels";
import type { ChannelKey } from "@/components/hub/types";
import { CHANNEL_LABEL } from "@/components/hub/types";

export type WizardTemplate = "sales" | "recruitment" | "custom";

type Msg = { role: "user" | "assistant"; content: string };
type IntakeMode = "inbound" | "keyword" | "tag" | "outreach";
type Objective = "qualification_only" | "qualification_and_booking" | "booking_only";

interface Answers {
  purpose?: string;
  intakeMode?: IntakeMode;
  intakeDetail?: string; // palavra-chave OU tags (vírgula)
  outreachOpening?: string;
  channels: ChannelKey[];
  identityMode?: "assistant" | "human";
  identityName?: string;
  objective?: Objective;
  qualification?: string;
  specialist?: string;
  postBooking?: "stop_and_handoff" | "continue_until_appointment";
  followup?: boolean;
  hours?: boolean;
}

interface Composed {
  name: string;
  identity_name: string;
  purpose_summary: string;
  custom_instructions: string;
  qualification_fields: { label: string; type: string; required: boolean }[];
  tone: { creativity: number; formality: number; naturalness: number; assertiveness: number };
}

// Copy por template — só o que muda de venda/recrutamento/custom.
const META: Record<WizardTemplate, {
  title: string; intro: string; purposeQ: string; purposePlaceholder: string;
  leadNoun: string; face: string; defaultName: string;
}> = {
  sales: {
    title: "Montar agente de venda",
    intro: "Responda clicando, escrevendo ou gravando áudio. A IA monta o agente de venda — você revisa e ativa.",
    purposeQ: "Pra começar: o que você vende e pra quem? Fala do produto, do público e do diferencial — quanto mais contexto, melhor. Pode escrever ou gravar um áudio. 🎙️",
    purposePlaceholder: "Ex: seguro de vida pra famílias brasileiras na Flórida, foco em proteção + acúmulo…",
    leadNoun: "leads", face: "fala com leads", defaultName: "Agente de Venda",
  },
  recruitment: {
    title: "Montar agente de recrutamento",
    intro: "Responda clicando, escrevendo ou gravando áudio. A IA monta o agente de recrutamento — você revisa e ativa.",
    purposeQ: "Pra começar: que perfil você recruta e qual a oportunidade? Fala da vaga, dos requisitos e do que você oferece. Pode escrever ou gravar um áudio. 🎙️",
    purposePlaceholder: "Ex: recruto futuros agentes de seguro, comissão alta + treinamento, busco perfil comunicativo…",
    leadNoun: "candidatos", face: "fala com candidatos", defaultName: "Agente de Recrutamento",
  },
  custom: {
    title: "Montar agente personalizado",
    intro: "Respondendo, clicando ou gravando áudio. A IA monta o agente — você revisa e ativa depois.",
    purposeQ: "Pra começar: o que esse agente vai fazer? Fala da campanha, da oferta, pra quem é — quanto mais contexto, melhor. Pode escrever ou gravar um áudio. 🎙️",
    purposePlaceholder: "Ex: agente do feirão de seguro de vida, fala com quem viu o anúncio no Instagram…",
    leadNoun: "leads", face: "fala com leads", defaultName: "Agente personalizado",
  },
};

type NodeKey =
  | "purpose" | "intake" | "intake_detail" | "outreach_opening" | "channel"
  | "identity" | "identity_name" | "objective" | "qualification"
  | "specialist" | "postbooking" | "followup" | "hours";

type Chip = { label: string; value: string };
interface NodeDef {
  type: "free" | "choice" | "multi";
  q: string | ((a: Answers) => string);
  chips?: Chip[];
  audio?: boolean;
  skippable?: boolean;
  placeholder?: string;
}

function buildNodes(template: WizardTemplate): Record<NodeKey, NodeDef> {
  const m = META[template];
  const isRec = template === "recruitment";
  const noun = m.leadNoun;
  return {
    purpose: { type: "free", audio: true, q: m.purposeQ, placeholder: m.purposePlaceholder },
    intake: {
      type: "choice",
      q: `Como os ${noun} vão chegar até esse agente?`,
      chips: [
        { label: "Eles me mandam mensagem", value: "inbound" },
        { label: "Campanha com palavra-chave", value: "keyword" },
        { label: "Só quem eu marco com uma tag", value: "tag" },
        { label: "O agente vai atrás (prospecção)", value: "outreach" },
      ],
    },
    intake_detail: {
      type: "free",
      q: (a) =>
        a.intakeMode === "keyword"
          ? "Qual é a palavra-chave que a pessoa manda pra ativar? (ex: SEGURO, VAGA)"
          : a.intakeMode === "outreach"
          ? "Qual lista o agente vai abordar? Use a tag dos contatos (uma ou mais, separadas por vírgula)."
          : `Qual tag marca esses ${noun}? (uma ou mais, separadas por vírgula)`,
      placeholder: "ex: feirao_2026, lead_quente",
    },
    outreach_opening: {
      type: "free",
      skippable: true,
      q: "Como deve ser a 1ª mensagem que ele manda? (deixa em branco que a IA cria com base no propósito)",
      placeholder: "Ex: Oi {first_name}! Vi que você se interessou…",
    },
    channel: {
      type: "multi",
      q: "Por quais canais ele conversa? (pode escolher mais de um)",
      chips: [
        { label: CHANNEL_LABEL.whatsapp_web, value: "whatsapp_web" },
        { label: CHANNEL_LABEL.whatsapp_api, value: "whatsapp_api" },
        { label: CHANNEL_LABEL.instagram, value: "instagram" },
      ],
    },
    identity: {
      type: "choice",
      q: `Como ele se apresenta pro ${isRec ? "candidato" : "lead"}?`,
      chips: [
        { label: "Como uma pessoa do time", value: "human" },
        { label: "Como uma assistente virtual", value: "assistant" },
      ],
    },
    identity_name: { type: "free", skippable: true, q: "Que nome ele usa? (ex: Bia, Léo) — ou pula que a gente define depois.", placeholder: "Nome do agente" },
    objective: {
      type: "choice",
      q: "Qual o objetivo dele na conversa?",
      chips: isRec
        ? [
            { label: "Só triar", value: "qualification_only" },
            { label: "Triar + agendar entrevista", value: "qualification_and_booking" },
            { label: "Só agendar entrevista", value: "booking_only" },
          ]
        : [
            { label: "Só qualificar", value: "qualification_only" },
            { label: "Qualificar e agendar", value: "qualification_and_booking" },
            { label: "Só agendar", value: "booking_only" },
          ],
    },
    qualification: {
      type: "free",
      audio: true,
      skippable: true,
      q: isRec
        ? "O que ele precisa descobrir do candidato? (ex: experiência, disponibilidade, documentação). Pode gravar um áudio — ou pular."
        : "O que ele precisa descobrir do lead? (ex: cidade, idade, orçamento, se já tem seguro). Pode gravar um áudio — ou pular.",
      placeholder: isRec ? "Ex: se já tem licença, disponibilidade, por que quer entrar na área." : "Ex: a cidade, a idade e se já tem algum seguro hoje.",
    },
    specialist: {
      type: "free",
      skippable: true,
      q: isRec ? "Quem conduz a entrevista? (nome — ou pula)" : "Quem conduz a reunião/atendimento depois? (nome do especialista — ou pula)",
      placeholder: isRec ? "Ex: Ana (recrutadora)" : "Ex: Dr. Pereira",
    },
    postbooking: {
      type: "choice",
      q: isRec ? "Depois de agendar a entrevista, o que ele faz?" : "Depois de agendar, o que ele faz?",
      chips: [
        { label: "Passa pra um humano", value: "stop_and_handoff" },
        { label: isRec ? "Continua até a entrevista" : "Continua até a reunião", value: "continue_until_appointment" },
      ],
    },
    followup: {
      type: "choice",
      q: `Se o ${isRec ? "candidato" : "lead"} sumir, o agente insiste (follow-up)?`,
      chips: [{ label: "Sim, faz follow-up", value: "yes" }, { label: "Não", value: "no" }],
    },
    hours: {
      type: "choice",
      q: "Tem horário de atendimento?",
      chips: [{ label: "24/7 — responde sempre", value: "always" }, { label: "Horário comercial (seg–sex)", value: "business" }],
    },
  };
}

const ORDER: NodeKey[] = [
  "purpose", "intake", "intake_detail", "outreach_opening", "channel",
  "identity", "identity_name", "objective", "qualification",
  "specialist", "postbooking", "followup", "hours",
];
const isBooking = (a: Answers) => a.objective === "qualification_and_booking" || a.objective === "booking_only";
function nodeVisible(key: NodeKey, a: Answers): boolean {
  if (key === "intake_detail") return a.intakeMode === "keyword" || a.intakeMode === "tag" || a.intakeMode === "outreach";
  if (key === "outreach_opening") return a.intakeMode === "outreach";
  if (key === "specialist" || key === "postbooking") return isBooking(a);
  return true;
}
function nextNode(cur: NodeKey, a: Answers): NodeKey | null {
  const i = ORDER.indexOf(cur);
  for (let j = i + 1; j < ORDER.length; j++) if (nodeVisible(ORDER[j], a)) return ORDER[j];
  return null;
}

type Phase = "wizard" | "composing" | "review" | "creating";

export function AgentWizard({ template }: { template: WizardTemplate }) {
  const router = useRouter();
  const meta = META[template];
  const NODES = useMemo(() => buildNodes(template), [template]);

  const [phase, setPhase] = useState<Phase>("wizard");
  const [node, setNode] = useState<NodeKey>("purpose");
  const [msgs, setMsgs] = useState<Msg[]>(() => [{ role: "assistant", content: txt(NODES.purpose.q, {} as Answers) }]);
  const [a, setA] = useState<Answers>({ channels: [] });
  const [input, setInput] = useState("");
  const [composed, setComposed] = useState<Composed | null>(null);
  const [creating, setCreating] = useState(false);

  // áudio
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, pendingAudio, phase]);

  const def = NODES[node];
  const pushBot = (content: string) => setMsgs((mm) => [...mm, { role: "assistant", content }]);
  const pushUser = (content: string) => setMsgs((mm) => [...mm, { role: "user", content }]);
  const busy = recording || transcribing || phase !== "wizard";

  function answer(patch: Partial<Answers>, display: string) {
    pushUser(display);
    const merged = { ...a, ...patch, channels: patch.channels ?? a.channels };
    setA(merged);
    const nxt = nextNode(node, merged);
    if (nxt) {
      setNode(nxt);
      setTimeout(() => pushBot(txt(NODES[nxt].q, merged)), 220);
    } else {
      void compose(merged);
    }
  }

  function submitFree(value: string) {
    const text = value.trim();
    const skip = text.length === 0;
    if (skip && !def.skippable) return;
    const display = skip ? "— pulei —" : text;
    if (node === "purpose") return answer({ purpose: text }, display);
    if (node === "intake_detail") return answer({ intakeDetail: text }, display);
    if (node === "outreach_opening") return answer({ outreachOpening: text }, skip ? "A IA cria a abertura" : display);
    if (node === "identity_name") return answer({ identityName: text }, skip ? "Definir depois" : display);
    if (node === "qualification") return answer({ qualification: text }, skip ? "A IA sugere" : display);
    if (node === "specialist") return answer({ specialist: text }, skip ? "Sem responsável fixo" : display);
  }
  function submitChoice(c: Chip) {
    if (node === "intake") return answer({ intakeMode: c.value as IntakeMode }, c.label);
    if (node === "identity") return answer({ identityMode: c.value as "assistant" | "human" }, c.label);
    if (node === "objective") return answer({ objective: c.value as Objective }, c.label);
    if (node === "postbooking") return answer({ postBooking: c.value as Answers["postBooking"] }, c.label);
    if (node === "followup") return answer({ followup: c.value === "yes" }, c.label);
    if (node === "hours") return answer({ hours: c.value === "business" }, c.label);
  }
  function submitMulti() {
    if (a.channels.length === 0) { toast.info("Escolha ao menos um canal."); return; }
    answer({ channels: a.channels }, a.channels.map((c) => CHANNEL_LABEL[c]).join(" · "));
  }
  const toggleChannel = (k: ChannelKey) =>
    setA((prev) => ({ ...prev, channels: prev.channels.includes(k) ? prev.channels.filter((x) => x !== k) : [...prev.channels, k] }));

  async function compose(ans: Answers) {
    setPhase("composing");
    try {
      const res = await fetch("/api/agent-platform/builder/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: {
            template,
            purpose: ans.purpose || "",
            qualification_hint: ans.qualification || "",
            intake: { mode: ans.intakeMode || "inbound", keyword: ans.intakeMode === "keyword" ? ans.intakeDetail : "", tags: ans.intakeMode === "tag" || ans.intakeMode === "outreach" ? splitTags(ans.intakeDetail) : [] },
            identity: { mode: ans.identityMode || "assistant", name: ans.identityName || "" },
            objective: ans.objective || "qualification_and_booking",
            channels: ans.channels.map((c) => CHANNEL_LABEL[c]),
          },
        }),
      });
      const data = (await res.json()) as Composed & { degraded?: boolean };
      if (!res.ok) throw new Error("compose falhou");
      setComposed(data);
      setPhase("review");
      pushBot("Pronto! Montei a proposta — confere na ficha ao lado e clica em Criar quando quiser. ✨");
      if (ans.intakeMode === "outreach") {
        setTimeout(() => pushBot("Obs.: a prospecção ativa (o agente iniciar conversas) é liberada pela agência num passo supervisionado. Por ora ele já responde quem chega; o disparo da lista entra depois."), 400);
      }
    } catch {
      setComposed({
        name: ans.identityName ? `${meta.defaultName} ${ans.identityName}` : meta.defaultName,
        identity_name: ans.identityName || "",
        purpose_summary: (ans.purpose || "").slice(0, 200),
        custom_instructions: ans.purpose || "",
        qualification_fields: [],
        tone: { creativity: 60, formality: 50, naturalness: 80, assertiveness: 50 },
      });
      setPhase("review");
      pushBot("Montei uma proposta inicial — confere na ficha ao lado e ajusta depois na configuração.");
    }
  }

  function buildSpec(): Record<string, unknown> | null {
    if (!composed) return null;
    const booking = isBooking(a);
    return {
      name: composed.name,
      purpose_summary: composed.purpose_summary,
      channels: a.channels.length ? a.channels : ["whatsapp_web"],
      intake: {
        mode: a.intakeMode || "inbound",
        tags: a.intakeMode === "tag" || a.intakeMode === "outreach" ? splitTags(a.intakeDetail) : [],
        keyword: a.intakeMode === "keyword" ? (a.intakeDetail || "") : "",
        opening_message: a.outreachOpening || "",
      },
      behavior: { tone: composed.tone, custom_instructions: composed.custom_instructions, confirmation_mode: "medium_and_high" },
      qualification_fields: composed.qualification_fields,
      followup: { enabled: !!a.followup, intensity: 5, max_attempts: 3 },
      active_hours: { enabled: !!a.hours, timezone: "America/New_York", mode: "only_during" },
      identity: { name: composed.identity_name || a.identityName || "", mode: a.identityMode || "assistant" },
      objective: a.objective || "qualification_and_booking",
      scheduling: booking
        ? { specialist_name: a.specialist || "", preferred_time_slot: "any", post_booking: { behavior: a.postBooking || "stop_and_handoff", handoff_message: "", allow_reschedule: true } }
        : undefined,
    };
  }

  async function createAgent() {
    const spec = buildSpec();
    if (!spec || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agent-platform/builder/commit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec, template }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falhou");
      setPhase("creating");
      setTimeout(() => router.push(`/hub/agents/${data.agent.id}`), 2200);
    } catch (err) {
      setCreating(false);
      toast.error("Não consegui criar o agente: " + (err instanceof Error ? err.message : ""));
    }
  }

  // ─── Áudio ────────────────────────────────────────────────────
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void uploadAudio(new Blob(chunksRef.current, { type: "audio/webm" })); };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch {
      toast.error("Não consegui acessar o microfone. Você pode escrever a resposta.");
    }
  }
  function stopRec() { setRecording(false); mediaRef.current?.stop(); }
  async function uploadAudio(blob: Blob) {
    if (blob.size < 200) return;
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "audio.webm");
      const res = await fetch("/api/agent-platform/builder/audio", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falhou");
      const summary = (data.summary || "").trim();
      if (!summary) { toast.info("Não entendi o áudio — tenta de novo ou escreve."); return; }
      setPendingAudio(summary);
    } catch (err) {
      toast.error("Erro na transcrição: " + (err instanceof Error ? err.message : ""));
    } finally { setTranscribing(false); }
  }

  // ─── Montando (animação) ──────────────────────────────────────
  if (phase === "creating" && composed) {
    const mods = buildModulesPreview(a);
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
            <div className="asm-mark"><AMark templateKey={template} size="xl" /></div>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Montando seu agente…</h2>
          <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 18px" }}>{composed.name}</p>
          <div className="col" style={{ gap: 8, textAlign: "left", maxWidth: 360, margin: "0 auto" }}>
            {mods.map((k, i) => (
              <div key={k} className="asm-row card card--flat" style={{ animationDelay: `${i * 110}ms`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)" }}>
                <Check size={14} style={{ color: "var(--success)" }} />
                <span style={{ fontSize: 13.5 }}>{MODULE_LABEL[k] || k}</span>
              </div>
            ))}
          </div>
          <div className="asm-bar" style={{ marginTop: 20, height: 5, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}><i /></div>
        </div>
      </div>
    );
  }

  const isTagNode = node === "intake_detail" && (a.intakeMode === "tag" || a.intakeMode === "outreach");
  const showChips = phase === "wizard" && def.type === "choice" && !pendingAudio;
  const showMulti = phase === "wizard" && def.type === "multi" && !pendingAudio;
  const showTags = phase === "wizard" && def.type === "free" && isTagNode && !pendingAudio;
  const showComposer = phase === "wizard" && def.type === "free" && !isTagNode;
  const audioAllowed = showComposer && !!def.audio;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <Link href="/hub/agents/new" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>{meta.title}</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>{meta.intro}</p>

      <div className="builder-split">
        <div className="card" style={{ display: "flex", flexDirection: "column", height: "min(640px, 72vh)" }}>
          <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.map((mm, i) => (
              <div key={i} className={"bub " + (mm.role === "user" ? "bub--user" : "bub--bot")}>{mm.content}</div>
            ))}
            {(phase === "composing" || transcribing) && (
              <div role="status" aria-live="polite" style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--ink-3)", padding: "2px 6px" }}>
                {transcribing ? "transcrevendo…" : "montando a proposta…"}
              </div>
            )}
            {pendingAudio && (
              <div className="card" style={{ alignSelf: "stretch", padding: 12, border: "1px solid var(--primary)", background: "var(--primary-soft)" }}>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <Mic size={14} style={{ color: "var(--primary)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--primary-ink)" }}>Entendi isto do seu áudio:</span>
                </div>
                <div style={{ fontSize: 13.5, color: "var(--ink)", marginBottom: 12, lineHeight: 1.5 }}>{pendingAudio}</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn--primary btn--sm" onClick={() => { const s = pendingAudio; setPendingAudio(null); submitFree(s!); }}>
                    <Check size={13} /> Confirmar e enviar
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => { setInput(pendingAudio!); setPendingAudio(null); }}>
                    <Pencil size={13} /> Editar
                  </button>
                  <button className="btn btn--quiet btn--sm" onClick={() => setPendingAudio(null)}>Descartar</button>
                </div>
              </div>
            )}
          </div>

          {showChips && (
            <div className="row wrap" style={{ gap: 8, padding: "0 12px 12px" }}>
              {def.chips!.map((c) => (
                <button key={c.value} className="chip-suggest" onClick={() => submitChoice(c)}>{c.label}</button>
              ))}
            </div>
          )}

          {showMulti && (
            <div style={{ padding: "0 12px 12px" }}>
              <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
                {def.chips!.map((c) => {
                  const on = a.channels.includes(c.value as ChannelKey);
                  return (
                    <button key={c.value} className="chip-suggest" aria-pressed={on} onClick={() => toggleChannel(c.value as ChannelKey)} style={on ? { borderColor: "var(--primary)", background: "var(--primary-soft)", color: "var(--primary-ink)" } : undefined}>
                      {on && <Check size={12} style={{ marginRight: 4 }} />}{c.label}
                    </button>
                  );
                })}
              </div>
              <button className="btn btn--primary btn--sm" onClick={submitMulti}>Continuar</button>
            </div>
          )}

          {showTags && <TagInput onSubmit={(tags) => submitFree(tags.join(", "))} />}

          {showComposer && (
            <div style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {audioAllowed && (
                  recording ? (
                    <button className="btn btn--danger btn--icon" onClick={stopRec} title="Parar" aria-label="Parar"><Square size={14} /></button>
                  ) : (
                    <button className="btn btn--ghost btn--icon" onClick={startRec} disabled={busy || !!pendingAudio} title="Gravar áudio" aria-label="Gravar áudio"><Mic size={15} /></button>
                  )
                )}
                <input
                  className="input"
                  aria-label="Sua resposta"
                  placeholder={recording ? "Gravando… toque em parar" : (def.placeholder || "Escreva aqui…")}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !busy && input.trim()) { const v = input; setInput(""); submitFree(v); } }}
                  disabled={busy || recording}
                />
                <button className="btn btn--primary" onClick={() => { if (input.trim()) { const v = input; setInput(""); submitFree(v); } }} disabled={busy || !input.trim()} aria-label="Enviar"><Send size={14} /></button>
              </div>
              {def.skippable && !recording && !pendingAudio && (
                <button className="btn btn--quiet btn--sm" style={{ marginTop: 8 }} onClick={() => submitFree("")}><SkipForward size={13} /> Pular</button>
              )}
            </div>
          )}
        </div>

        <div className="builder-ficha">
          <Ficha a={a} composed={composed} template={template} canCreate={phase === "review"} onCreate={createAgent} creating={creating} />
        </div>
      </div>
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────── */
function txt(q: string | ((a: Answers) => string), a: Answers): string {
  return typeof q === "function" ? q(a) : q;
}
function splitTags(s?: string): string[] {
  return (s || "").split(",").map((t) => t.trim()).filter(Boolean);
}
function cleanTagPhrase(raw: string): string[] {
  let s = raw.trim().replace(/["']/g, "");
  const m = s.match(/\btags?\s+(.+)$/i);
  if (m) s = m[1].trim();
  return s.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
}
function TagInput({ onSubmit }: { onSubmit: (tags: string[]) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [val, setVal] = useState("");
  const commit = (raw: string) => {
    const parts = cleanTagPhrase(raw);
    if (parts.length) setTags((p) => Array.from(new Set([...p, ...parts])));
    setVal("");
  };
  return (
    <div style={{ padding: 12, borderTop: "1px solid var(--line)" }}>
      {tags.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {tags.map((t) => (
            <span key={t} className="pill pill--muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {t}
              <button onClick={() => setTags((p) => p.filter((x) => x !== t))} aria-label="remover" style={{ border: 0, background: "none", cursor: "pointer", color: "var(--ink-4)", lineHeight: 1, fontSize: 14 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" aria-label="Adicionar tag" value={val} placeholder="Digite a tag e tecle Enter (ex: feirao_2026)" onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (val.trim()) commit(val); } }} />
        <button className="btn btn--ghost" onClick={() => { if (val.trim()) commit(val); }}>Adicionar</button>
      </div>
      <button className="btn btn--primary btn--sm" style={{ marginTop: 10 }} disabled={tags.length === 0} onClick={() => onSubmit(tags)}>Continuar</button>
    </div>
  );
}
const INTAKE_TXT: Record<IntakeMode, string> = {
  inbound: "Mandam mensagem", keyword: "Campanha (palavra-chave)", tag: "Por tag", outreach: "Prospecção (agente inicia)",
};
const OBJ_TXT: Record<Objective, string> = {
  qualification_only: "Qualificar", qualification_and_booking: "Qualificar + agendar", booking_only: "Agendar",
};
function buildModulesPreview(a: Answers): string[] {
  const m = ["channel", "qualification"];
  if (isBooking(a)) m.push("scheduling");
  if (a.followup) m.push("followup");
  if (a.hours) m.push("active_hours");
  if (a.intakeMode === "outreach") m.push("outreach");
  return m;
}

function ToneRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row between" style={{ marginBottom: 3 }}>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</span>
        <span className="tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{Math.round(value)}</span>
      </div>
      <div className="tone-bar"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
    </div>
  );
}
function Row({ n, label, value }: { n: number; label: string; value?: string }) {
  const done = !!value;
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <div style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 600, background: done ? "var(--primary)" : "var(--surface-3)", color: done ? "#fff" : "var(--ink-4)" }}>
        {done ? <Check size={11} /> : n}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{label}</div>
        <div style={{ fontSize: 13, color: done ? "var(--ink)" : "var(--ink-4)", lineHeight: 1.35 }}>{value || "—"}</div>
      </div>
    </div>
  );
}

function Ficha({ a, composed, template, canCreate, onCreate, creating }: { a: Answers; composed: Composed | null; template: WizardTemplate; canCreate: boolean; onCreate: () => void; creating: boolean }) {
  const meta = META[template];
  const intake = a.intakeMode ? INTAKE_TXT[a.intakeMode] + (a.intakeDetail ? ` · ${a.intakeDetail}` : "") : undefined;
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="row" style={{ gap: 12, marginBottom: 12 }}>
        <AMark templateKey={template} size="lg" />
        <div className="grow">
          <div style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.2 }}>{composed?.name || a.identityName || "Novo agente"}</div>
          <span className="pill pill--muted" style={{ marginTop: 4 }}>{meta.face}</span>
        </div>
      </div>
      {composed?.purpose_summary && <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.5 }}>{composed.purpose_summary}</p>}

      {a.channels.length > 0 && (
        <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
          {a.channels.map((c) => <ChannelChip key={c} name={c} />)}
        </div>
      )}

      <div className="col" style={{ gap: 9 }}>
        <Row n={1} label="Propósito" value={a.purpose ? trunc(a.purpose, 60) : undefined} />
        <Row n={2} label={`Como os ${meta.leadNoun} chegam`} value={intake} />
        <Row n={3} label="Identidade" value={a.identityMode ? (a.identityMode === "human" ? "Pessoa do time" : "Assistente virtual") + (a.identityName ? ` · ${a.identityName}` : "") : undefined} />
        <Row n={4} label="Objetivo" value={a.objective ? OBJ_TXT[a.objective] : undefined} />
        {isBooking(a) && <Row n={5} label="Agendamento" value={a.specialist ? `com ${a.specialist}` : (a.postBooking ? "configurado" : undefined)} />}
        <Row n={6} label="Persistência & horário" value={a.followup !== undefined ? `${a.followup ? "follow-up on" : "sem follow-up"} · ${a.hours ? "horário comercial" : a.hours === false ? "24/7" : ""}`.trim() : undefined} />
      </div>

      {composed && (
        <>
          <hr className="hr" style={{ margin: "14px 0" }} />
          <div className="eyebrow" style={{ marginBottom: 8 }}>Tom</div>
          <ToneRow label="Criatividade" value={composed.tone.creativity} />
          <ToneRow label="Formalidade" value={composed.tone.formality} />
          <ToneRow label="Naturalidade" value={composed.tone.naturalness} />
          <ToneRow label="Assertividade" value={composed.tone.assertiveness} />
          {composed.qualification_fields.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Vai descobrir · {composed.qualification_fields.length}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {composed.qualification_fields.map((f, i) => <span key={i} className="pill pill--muted" style={{ fontSize: 11.5 }}>{f.label}</span>)}
              </div>
            </>
          )}
        </>
      )}

      <button className="btn btn--primary" style={{ width: "100%", justifyContent: "center", marginTop: 18 }} onClick={onCreate} disabled={!canCreate || creating}>
        <Sparkles size={15} /> {creating ? "Criando…" : "Criar agente"}
      </button>
      <p className="muted" style={{ fontSize: 11.5, textAlign: "center", marginTop: 8 }}>Nasce pausado. Você revisa, testa e ativa.</p>
    </div>
  );
}
function trunc(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
