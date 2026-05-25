"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Lock, Check, Sparkles } from "lucide-react";
import { AMark } from "@/components/hub/primitives";
import { MODULE_LABEL } from "@/components/hub/module-labels";

export type NewTemplate = {
  key: string;
  name: string;
  description: string;
  default_modules: string[];
  entitled: boolean;
};

const DISPLAY_NAME: Record<string, string> = {
  sales: "Agente de Venda",
  recruitment: "Agente de Recrutamento",
  custom: "Agente Personalizado",
};

export function NewAgentFlow({ templates }: { templates: NewTemplate[] }) {
  const router = useRouter();
  const [step, setStep] = useState<"type" | "name" | "creating">("type");
  const [tplKey, setTplKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const tpl = templates.find((t) => t.key === tplKey);

  function pick(t: NewTemplate) {
    if (!t.entitled) {
      toast.info("Esse agente é um módulo pago e ainda não está liberado. Fale com o suporte pra ativar.");
      return;
    }
    if (t.key === "custom") {
      router.push("/hub/agents/new/custom");
      return;
    }
    setTplKey(t.key);
    setName("");
    setStep("name");
  }

  async function create() {
    if (!tpl || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agent-platform/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_key: tpl.key,
          name: name.trim() || DISPLAY_NAME[tpl.key] || tpl.name,
          module_keys: tpl.default_modules,
          start_paused: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falha ao criar");
      setStep("creating");
      // Deixa a animação de montagem rodar antes de cair na config.
      setTimeout(() => router.push(`/hub/agents/${data.agent.id}`), 2400);
    } catch (err) {
      setCreating(false);
      toast.error("Não consegui criar o agente: " + (err instanceof Error ? err.message : ""));
    }
  }

  // ─── Passo: montando (animação) ───────────────────────────────
  if (step === "creating" && tpl) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
            <div className="asm-mark">
              <AMark templateKey={tpl.key} size="xl" />
            </div>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600 }}>Montando seu agente…</h2>
          <p className="muted" style={{ fontSize: 13.5, margin: "6px 0 18px" }}>{name || DISPLAY_NAME[tpl.key]}</p>

          <div className="col" style={{ gap: 8, textAlign: "left", maxWidth: 360, margin: "0 auto" }}>
            {tpl.default_modules.map((k, i) => (
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

  // ─── Passo: nome ──────────────────────────────────────────────
  if (step === "name" && tpl) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <button className="btn btn--quiet btn--sm" onClick={() => setStep("type")} style={{ marginBottom: 12 }}>
          <ChevronLeft /> Voltar
        </button>
        <div className="card" style={{ padding: 24 }}>
          <div className="row" style={{ gap: 14, marginBottom: 18 }}>
            <AMark templateKey={tpl.key} size="lg" />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{tpl.name}</div>
              <h2 style={{ fontSize: 20, fontWeight: 600 }}>Como vai chamar?</h2>
            </div>
          </div>
          <input
            className="input"
            style={{ height: 46, fontSize: 16, padding: "0 14px" }}
            placeholder={`Ex: ${DISPLAY_NAME[tpl.key]} — plano de saúde`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            autoFocus
          />
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Esse nome aparece no Spark Leads. Você pode trocar depois.
          </p>
          <div className="card card--flat" style={{ marginTop: 16, padding: 12, background: "var(--surface-2)", display: "flex", gap: 10 }}>
            <Sparkles size={15} style={{ color: "var(--ink-3)", flexShrink: 0, marginTop: 2 }} />
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
              O agente nasce <strong>pausado</strong> com os ajustes do template. Você revisa, testa e ativa.
            </span>
          </div>
          <div className="row between" style={{ marginTop: 20 }}>
            <span className="muted" style={{ fontSize: 12 }}>$50/mês</span>
            <button className="btn btn--primary" onClick={create} disabled={creating}>
              <Check /> {creating ? "Criando…" : "Criar agente"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Passo: tipo ──────────────────────────────────────────────
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <Link href="/hub/agents" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar para agentes
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>Que tipo de agente?</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>
        O SparkBot já vem incluso. Aqui você adiciona um agente que fala com seus leads.
      </p>

      <div className="col" style={{ gap: 10 }}>
        {templates.map((t) => (
          <button
            key={t.key}
            onClick={() => pick(t)}
            className="card"
            style={{
              textAlign: "left",
              padding: 18,
              cursor: t.entitled ? "pointer" : "not-allowed",
              opacity: t.entitled ? 1 : 0.6,
              display: "grid",
              gridTemplateColumns: "auto 1fr auto",
              gap: 16,
              alignItems: "center",
            }}
          >
            <AMark templateKey={t.key} size="lg" />
            <div>
              <div style={{ fontSize: 15.5, fontWeight: 600 }}>{DISPLAY_NAME[t.key] || t.name}</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 2, lineHeight: 1.45 }}>{t.description}</div>
              {t.key === "custom" && (
                <div style={{ fontSize: 12, color: "var(--primary)", marginTop: 6, display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Sparkles size={12} /> Montado com IA, conversando
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {t.entitled ? (
                <span className="pill pill--muted"><span className="mono">$50</span>/mês</span>
              ) : (
                <span className="pill pill--muted"><Lock size={11} /> Bloqueado</span>
              )}
              <ChevronRight size={16} style={{ color: "var(--ink-4)" }} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
