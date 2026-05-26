"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, Send, Sparkles, Check, Wand2, Mic, Square, X, Pencil } from "lucide-react";
import { AMark, ChannelChip } from "@/components/hub/primitives";
import { MODULE_LABEL } from "@/components/hub/module-labels";
import type { ChannelKey } from "@/components/hub/types";

type Msg = { role: "user" | "assistant"; content: string };

interface Spec {
  name: string;
  purpose_summary: string;
  channels: ChannelKey[];
  modules: string[];
  behavior: { tone: { creativity: number; formality: number; naturalness: number; assertiveness: number }; custom_instructions: string; confirmation_mode: string };
  qualification_fields?: { label: string; type: string; required: boolean }[];
  expires_at?: string | null;
}

// Wizard: 3 perguntas estruturadas (Pedro 2026-05-26). Cada uma com opções
// clicáveis (chips), mas o usuário pode escrever ou (na campanha) gravar áudio.
const STEPS: { key: "channel" | "identity" | "campaign"; q: string; chips: string[]; audio: boolean }[] = [
  { key: "channel", q: "Como os leads vão chegar até esse agente?", chips: ["WhatsApp Web/SMS", "WhatsApp API", "Instagram"], audio: false },
  { key: "identity", q: "Como você quer que ele se apresente pro lead?", chips: ["Como uma assistente virtual", "Como uma pessoa do time"], audio: false },
  { key: "campaign", q: "Agora me conta os detalhes da campanha — quanto mais contexto, melhor (público, oferta, objetivo…). Pode escrever ou gravar um áudio.", chips: [], audio: true },
];

type Phase = "wizard" | "ai" | "creating";

export function CustomBuilder() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("wizard");
  const [step, setStep] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "assistant", content: STEPS[0].q }]);
  const [answers, setAnswers] = useState<{ channel?: string; identity?: string; campaign?: string }>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [creating, setCreating] = useState(false);

  // áudio
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const convoRef = useRef<Msg[]>([]); // conversa enviada à IA (fase "ai")
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading, pendingAudio]);

  const pushBot = (content: string) => setMsgs((m) => [...m, { role: "assistant", content }]);
  const pushUser = (content: string) => setMsgs((m) => [...m, { role: "user", content }]);

  const audioAllowed = (phase === "wizard" && STEPS[step]?.audio) || phase === "ai";
  const canType = !loading && !creating && (phase === "wizard" || phase === "ai");

  async function callBuilder(convo: Msg[]) {
    setLoading(true);
    try {
      const res = await fetch("/api/agent-platform/builder/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: convo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falhou");
      if (data.spec) {
        setSpec(data.spec as Spec);
        pushBot("Pronto! Montei uma proposta — confira na ficha ao lado e clique em Criar quando quiser.");
      } else {
        pushBot(data.assistant || "Me conta um pouco mais?");
      }
    } catch (err) {
      pushBot("Tive um problema aqui: " + (err instanceof Error ? err.message : "erro") + ". Pode tentar de novo?");
    } finally {
      setLoading(false);
    }
  }

  function enterAi(campaign: string) {
    setPhase("ai");
    const synth =
      `Quero montar um agente personalizado (lead-facing).\n` +
      `- Canal de chegada dos leads: ${answers.channel || "—"}\n` +
      `- Como deve se apresentar: ${answers.identity || "—"}\n` +
      `- Detalhes da campanha: ${campaign}`;
    convoRef.current = [{ role: "user", content: synth }];
    void callBuilder(convoRef.current);
  }

  // Recebe uma resposta (chip / texto / áudio confirmado) e avança o fluxo.
  function submitAnswer(value: string) {
    const text = value.trim();
    if (!text) return;
    pushUser(text);
    if (phase === "wizard") {
      const cur = STEPS[step];
      setAnswers((a) => ({ ...a, [cur.key]: text }));
      if (step < STEPS.length - 1) {
        const next = step + 1;
        setStep(next);
        setTimeout(() => pushBot(STEPS[next].q), 250);
      } else {
        enterAi(text); // campanha respondida → IA compõe
      }
    } else {
      // fase ai — segue conversando com a IA
      convoRef.current = [...convoRef.current, { role: "user", content: text }];
      void callBuilder(convoRef.current);
    }
  }

  // ─── Áudio ────────────────────────────────────────────────────
  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        void uploadAudio(blob);
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch {
      toast.error("Não consegui acessar o microfone. Verifique a permissão.");
    }
  }
  function stopRec() {
    setRecording(false);
    mediaRef.current?.stop();
  }
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
    } finally {
      setTranscribing(false);
    }
  }

  async function createAgent() {
    if (!spec || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agent-platform/builder/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falhou");
      setPhase("creating");
      setTimeout(() => router.push(`/hub/agents/${data.agent.id}`), 2400);
    } catch (err) {
      setCreating(false);
      toast.error("Não consegui criar o agente: " + (err instanceof Error ? err.message : ""));
    }
  }

  // ─── Montando (animação) ──────────────────────────────────────
  if (phase === "creating" && spec) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
            <div className="asm-mark"><AMark templateKey="custom" size="xl" /></div>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Montando seu agente…</h2>
          <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 18px" }}>{spec.name}</p>
          <div className="col" style={{ gap: 8, textAlign: "left", maxWidth: 360, margin: "0 auto" }}>
            {spec.modules.map((k, i) => (
              <div key={k} className="asm-row card card--flat" style={{ animationDelay: `${i * 120}ms`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)" }}>
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

  const showChips = phase === "wizard" && !loading && STEPS[step]?.chips.length > 0 && !pendingAudio;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <Link href="/hub/agents/new" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>Montar agente personalizado</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>
        Responda 3 perguntas — clicando, escrevendo ou gravando um áudio. A IA monta o agente e você ajusta depois.
      </p>

      <div className="builder-split">
        {/* Conversa */}
        <div className="card" style={{ display: "flex", flexDirection: "column", height: "min(620px, 70vh)" }}>
          <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.map((m, i) => (
              <div key={i} className={"bub " + (m.role === "user" ? "bub--user" : "bub--bot")}>{m.content}</div>
            ))}
            {(loading || transcribing) && (
              <div style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--ink-3)", padding: "2px 6px" }}>
                {transcribing ? "transcrevendo…" : "pensando…"}
              </div>
            )}

            {/* Confirmar resumo do áudio */}
            {pendingAudio && (
              <div className="card" style={{ alignSelf: "stretch", padding: 12, border: "1px solid var(--primary)", background: "var(--primary-soft)" }}>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <Mic size={14} style={{ color: "var(--primary)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--primary-ink)" }}>Entendi isto do seu áudio:</span>
                </div>
                <div style={{ fontSize: 13.5, color: "var(--ink)", marginBottom: 12, lineHeight: 1.5 }}>{pendingAudio}</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn--primary btn--sm" onClick={() => { const s = pendingAudio; setPendingAudio(null); submitAnswer(s!); }}>
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

          {/* Chips de opção */}
          {showChips && (
            <div className="row wrap" style={{ gap: 8, padding: "0 12px 10px" }}>
              {STEPS[step].chips.map((c) => (
                <button key={c} className="chip-suggest" onClick={() => submitAnswer(c)}>{c}</button>
              ))}
            </div>
          )}

          {/* Composer */}
          <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 8, alignItems: "center" }}>
            {audioAllowed && (
              recording ? (
                <button className="btn btn--danger btn--icon" onClick={stopRec} title="Parar gravação" aria-label="Parar"><Square size={14} /></button>
              ) : (
                <button className="btn btn--ghost btn--icon" onClick={startRec} disabled={loading || transcribing || !!pendingAudio} title="Gravar áudio" aria-label="Gravar áudio"><Mic size={15} /></button>
              )
            )}
            <input
              className="input"
              placeholder={recording ? "Gravando… toque em parar" : "Escreva aqui…"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canType && input.trim()) { const v = input; setInput(""); submitAnswer(v); } }}
              disabled={!canType || recording}
            />
            <button className="btn btn--primary" onClick={() => { if (input.trim()) { const v = input; setInput(""); submitAnswer(v); } }} disabled={!canType || !input.trim()} aria-label="Enviar">
              <Send size={14} />
            </button>
          </div>
        </div>

        {/* Ficha ao vivo */}
        <div className="builder-ficha">
          <Ficha spec={spec} answers={answers} onCreate={createAgent} creating={creating} />
        </div>
      </div>
    </div>
  );
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

function Ficha({ spec, answers, onCreate, creating }: { spec: Spec | null; answers: { channel?: string; identity?: string; campaign?: string }; onCreate: () => void; creating: boolean }) {
  if (!spec) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <div className="row" style={{ gap: 10, marginBottom: 12 }}>
          <Wand2 size={20} style={{ color: "var(--ink-4)" }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>Montando com você</div>
        </div>
        <div className="col" style={{ gap: 10 }}>
          <FichaStep n={1} label="Canal" value={answers.channel} />
          <FichaStep n={2} label="Apresentação" value={answers.identity} />
          <FichaStep n={3} label="Campanha" value={answers.campaign} />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>Conforme você responde, o agente vai tomando forma aqui.</p>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="row" style={{ gap: 12, marginBottom: 12 }}>
        <AMark templateKey="custom" size="lg" />
        <div className="grow">
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>{spec.name || "—"}</div>
          <span className="pill pill--muted" style={{ marginTop: 4 }}>fala com leads</span>
        </div>
      </div>
      {spec.purpose_summary && <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 12px", lineHeight: 1.5 }}>{spec.purpose_summary}</p>}
      <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
        {spec.channels?.map((c) => <ChannelChip key={c} name={c} />)}
        {spec.expires_at && <span className="pill pill--warn">expira {spec.expires_at}</span>}
      </div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Tom</div>
      <ToneRow label="Criatividade" value={spec.behavior?.tone?.creativity ?? 50} />
      <ToneRow label="Formalidade" value={spec.behavior?.tone?.formality ?? 50} />
      <ToneRow label="Naturalidade" value={spec.behavior?.tone?.naturalness ?? 50} />
      <ToneRow label="Assertividade" value={spec.behavior?.tone?.assertiveness ?? 50} />
      <hr className="hr" style={{ margin: "14px 0" }} />
      <div className="eyebrow" style={{ marginBottom: 8 }}>Ajustes · {spec.modules?.length || 0}</div>
      <div className="col" style={{ gap: 5 }}>
        {spec.modules?.map((k) => (
          <div key={k} className="row" style={{ gap: 8, fontSize: 13 }}><Check size={13} style={{ color: "var(--success)" }} /> {MODULE_LABEL[k] || k}</div>
        ))}
      </div>
      <button className="btn btn--primary" style={{ width: "100%", justifyContent: "center", marginTop: 18 }} onClick={onCreate} disabled={creating}>
        <Sparkles size={15} /> Criar agente
      </button>
      <p className="muted" style={{ fontSize: 11.5, textAlign: "center", marginTop: 8 }}>Nasce pausado. Você revisa, testa e ativa.</p>
    </div>
  );
}

function FichaStep({ n, label, value }: { n: number; label: string; value?: string }) {
  const done = !!value;
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <div style={{ width: 22, height: 22, borderRadius: 999, flexShrink: 0, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 600, background: done ? "var(--primary)" : "var(--surface-3)", color: done ? "#fff" : "var(--ink-4)" }}>
        {done ? <Check size={12} /> : n}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{label}</div>
        <div style={{ fontSize: 13, color: done ? "var(--ink)" : "var(--ink-4)", lineHeight: 1.4 }}>{value || "—"}</div>
      </div>
    </div>
  );
}
