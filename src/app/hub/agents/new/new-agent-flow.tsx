"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Lock, Sparkles } from "lucide-react";
import { AMark } from "@/components/hub/primitives";

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

  function pick(t: NewTemplate) {
    if (!t.entitled) {
      toast.info("Esse agente é um módulo pago e ainda não está liberado. Fale com o suporte pra ativar.");
      return;
    }
    // Todos os tipos usam o mesmo wizard guiado (perguntas → IA monta → revisa).
    router.push(`/hub/agents/new/${t.key}`);
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <Link href="/hub/agents" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar para agentes
      </Link>
      <h1 className="page-hd__title" style={{ marginBottom: 4 }}>Que tipo de agente?</h1>
      <p className="page-hd__sub" style={{ marginBottom: 20 }}>
        O SparkBot já vem incluso. Aqui você adiciona um agente que fala com seus leads — montado com a IA, respondendo a algumas perguntas.
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
              <div style={{ fontSize: 12, color: "var(--primary)", marginTop: 6, display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Sparkles size={12} /> Montado com IA, respondendo perguntas
              </div>
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
