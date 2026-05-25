import Link from "next/link";
import { ChevronLeft, Sparkles } from "lucide-react";

export default function CustomBuilderStub() {
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <Link href="/hub/agents/new" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
        <ChevronLeft /> Voltar
      </Link>
      <div className="card">
        <div className="empty">
          <Sparkles size={32} style={{ color: "var(--ink-4)" }} />
          <p style={{ marginTop: 12, marginBottom: 4, fontWeight: 600, color: "var(--ink)" }}>Agente Personalizado com IA</p>
          <p style={{ marginTop: 0 }}>
            O assistente que conversa com você pra entender e montar um agente do zero está sendo construído. Chega na próxima fase.
          </p>
        </div>
      </div>
    </div>
  );
}
