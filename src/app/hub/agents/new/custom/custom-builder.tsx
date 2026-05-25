"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, Send, Sparkles, Check, Wand2 } from "lucide-react";
import { AMark, ChannelChip } from "@/components/hub/primitives";
import { MODULE_LABEL } from "@/components/hub/module-labels";
import type { ChannelKey } from "@/components/hub/types";

type Msg = { role: "user" | "assistant"; content: string };

interface Spec {
  name: string;
  purpose_summary: string;
  channels: ChannelKey[];
  modules: string[];
  behavior: {
    tone: { creativity: number; formality: number; naturalness: number; assertiveness: number };
    custom_instructions: string;
    confirmation_mode: string;
  };
  qualification_fields?: { label: string; type: string; required: boolean }[];
  expires_at?: string | null;
}

const GREETING =
  "Oi! Me conta com suas palavras o que você quer que esse agente faça. Pode ser bem informal — eu cuido da parte técnica.";
const EXAMPLES = [
  "Um agente pro feirão de seguros que vai durar até junho",
  "Quero qualificar quem pede cotação de auto no Instagram",
  "Um agente que reativa clientes antigos no WhatsApp",
];

export function CustomBuilder() {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading || creating) return;
    const next: Msg[] = [...msgs, { role: "user", content }];
    setMsgs(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/agent-platform/builder/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falhou");
      setMsgs((m) => [...m, { role: "assistant", content: data.assistant }]);
      if (data.spec) setSpec(data.spec as Spec);
    } catch (err) {
      setMsgs((m) => [...m, { role: "assistant", content: "Tive um problema aqui: " + (err instanceof Error ? err.message : "erro") + ". Pode tentar de novo?" }]);
    } finally {
      setLoading(false);
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
      setTimeout(() => router.push(`/hub/agents/${data.agent.id}`), 2400);
    } catch (err) {
      setCreating(false);
      toast.error("Não consegui criar o agente: " + (err instanceof Error ? err.message : ""));
    }
  }

  // ─── Montando (animação) ──────────────────────────────────────
  if (creating && spec) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
            <div className="asm-mark">
              <AMark templateKey="custom" size="xl" />
            </div>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Montando seu agente…</h2>
          <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 18px" }}>{spec.name}</p>
          <div className="col" style={{ gap: 8, textAlign: "left", maxWidth: 360, margin: "0 auto" }}>
            {spec.modules.map((k, i) => (
              <div
                key={k}
                className="asm-row card card--flat"
                style={{ animationDelay: `${i * 120}ms`, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10, background: "var(--surface-2)" }}
              >
                <Check size={14} style={{ color: "var(--success)" }} />
                <span style={{ fontSize: 13.5 }}>{MODULE_LABEL[k] || k}</span>
              </div>
            ))}
          </div>
          <div className="asm-bar" style={{ marginTop: 20, height: 5, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden" }}>
            <i />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <Link href="/hub/agents/new" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>Montar agente personalizado</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>
        Descreva o que precisa. A IA pergunta o necessário e monta — você ajusta e testa depois.
      </p>

      <div className="builder-split">
        {/* Conversa */}
        <div className="card" style={{ display: "flex", flexDirection: "column", height: "min(600px, 68vh)" }}>
          <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {msgs.map((m, i) => (
              <div key={i} className={"bub " + (m.role === "user" ? "bub--user" : "bub--bot")}>
                {m.content}
              </div>
            ))}
            {loading && <div style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--ink-3)", padding: "2px 6px" }}>pensando…</div>}
          </div>

          {msgs.length <= 1 && (
            <div className="row wrap" style={{ gap: 8, padding: "0 12px 10px" }}>
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip-suggest" onClick={() => send(ex)} disabled={loading}>
                  {ex}
                </button>
              ))}
            </div>
          )}

          <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="Escreva aqui…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={loading}
              autoFocus
            />
            <button className="btn btn--primary" onClick={() => send()} disabled={loading || !input.trim()} aria-label="Enviar">
              <Send size={14} />
            </button>
          </div>
        </div>

        {/* Ficha ao vivo */}
        <div className="builder-ficha">
          <Ficha spec={spec} onCreate={createAgent} creating={creating} />
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
      <div className="tone-bar">
        <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function Ficha({ spec, onCreate, creating }: { spec: Spec | null; onCreate: () => void; creating: boolean }) {
  if (!spec) {
    return (
      <div className="card" style={{ padding: 24, borderStyle: "dashed", textAlign: "center" }}>
        <Wand2 size={22} style={{ color: "var(--ink-4)" }} />
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 10 }}>A ficha aparece aqui</div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
          Conforme a IA entende o que você quer, o agente vai se montando deste lado.
        </p>
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
          <div key={k} className="row" style={{ gap: 8, fontSize: 13 }}>
            <Check size={13} style={{ color: "var(--success)" }} /> {MODULE_LABEL[k] || k}
          </div>
        ))}
      </div>

      {spec.qualification_fields && spec.qualification_fields.length > 0 && (
        <>
          <hr className="hr" style={{ margin: "14px 0" }} />
          <div className="eyebrow" style={{ marginBottom: 8 }}>Pergunta aos leads</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {spec.qualification_fields.map((f, i) => (
              <span key={i} className="pill pill--muted">{f.label}</span>
            ))}
          </div>
        </>
      )}

      <button className="btn btn--primary" style={{ width: "100%", justifyContent: "center", marginTop: 18 }} onClick={onCreate} disabled={creating}>
        <Sparkles size={15} /> Criar agente
      </button>
      <p className="muted" style={{ fontSize: 11.5, textAlign: "center", marginTop: 8 }}>
        Nasce pausado. Você revisa, testa e ativa.
      </p>
    </div>
  );
}
