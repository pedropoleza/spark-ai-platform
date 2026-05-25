import Link from "next/link";
import { Sparkles, ChevronLeft } from "lucide-react";

export default function NewAgentPage() {
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <Link href="/hub/agents" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar para agentes
      </Link>
      <div className="card">
        <div className="empty">
          <Sparkles size={32} style={{ color: "var(--ink-4)" }} />
          <p style={{ marginTop: 12, marginBottom: 4, fontWeight: 600, color: "var(--ink)" }}>Novo agente</p>
          <p style={{ marginTop: 0 }}>
            O fluxo de criação — incluindo o assistente com IA para agentes personalizados — chega nas próximas fases.
          </p>
        </div>
      </div>
    </div>
  );
}
