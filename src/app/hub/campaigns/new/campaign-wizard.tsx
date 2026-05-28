"use client";

/**
 * Campaign wizard (Etapa 4.1 Commit B — Pedro 2026-05-28).
 *
 * 3 steps simples: agente · filtro+mensagem · revisar. POSTa em /api/hub/campaigns
 * que cria o bulk_message_job em status='paused' por segurança — admin ativa via
 * SparkBot chat ("iniciar campanha <label>") até o Commit 4.1.C trazer botões
 * direto na UI.
 *
 * Decisão pragmática (não escondida): filtro só por TAG no MVP. Filter Engine
 * (pipeline_stage, custom_field, AND/OR composto) vem em iteração futura, junto
 * com preview de destinatários. Antes disso, o admin usa o SparkBot chat pra
 * filtros complexos.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Check, Megaphone, AlertCircle } from "lucide-react";

export interface AgentChoice {
  id: string;
  name: string;
  templateKey: string;
}

const TPL_LABEL: Record<string, string> = {
  sales: "Vendas",
  recruitment: "Recrutamento",
  custom: "Personalizado",
};

type Step = 1 | 2 | 3;

export function CampaignWizard({ agents }: { agents: AgentChoice[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id || "");
  const [label, setLabel] = useState("");
  const [tag, setTag] = useState("");
  const [template, setTemplate] = useState("");
  const [intervalSec, setIntervalSec] = useState("90");
  const [submitting, setSubmitting] = useState(false);

  const selectedAgent = agents.find((a) => a.id === agentId);

  const canAdvance1 = !!agentId;
  const canAdvance2 = label.trim().length > 0 && tag.trim().length > 0 && template.trim().length > 0;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/hub/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          label: label.trim(),
          tag: tag.trim(),
          template: template.trim(),
          interval_seconds: Number(intervalSec) || 90,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "falha");
      }
      toast.success("Campanha criada em pausa — ative pelo SparkBot pra iniciar");
      router.push("/hub/campaigns");
    } catch (err) {
      toast.error("Não consegui criar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      {/* Steps indicator */}
      <div className="card-hd" style={{ borderBottom: "1px solid var(--line)" }}>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          {[1, 2, 3].map((n) => (
            <div key={n} className="row" style={{ gap: 6, alignItems: "center" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  background: step >= (n as Step) ? "var(--primary)" : "var(--surface-2)",
                  color: step >= (n as Step) ? "#fff" : "var(--ink-3)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {n}
              </span>
              <span style={{ fontSize: 12.5, color: step === n ? "var(--ink)" : "var(--ink-3)", fontWeight: step === n ? 500 : 400 }}>
                {n === 1 ? "Agente" : n === 2 ? "Filtro + mensagem" : "Revisar"}
              </span>
              {n < 3 && <ChevronRight size={14} style={{ color: "var(--ink-4)" }} />}
            </div>
          ))}
        </div>
      </div>

      <div className="card-body" style={{ padding: 20 }}>
        {/* Step 1: Agente */}
        {step === 1 && (
          <div className="col" style={{ gap: 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Qual agente vai disparar a campanha?</div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
                Só agentes lead-facing ativos. Cada agente envia pelos canais configurados nele.
              </div>
            </div>
            <div className="col" style={{ gap: 8 }}>
              {agents.map((a) => (
                <label
                  key={a.id}
                  className="row between"
                  style={{
                    gap: 10,
                    padding: "10px 12px",
                    border: agentId === a.id ? "2px solid var(--primary)" : "1px solid var(--line)",
                    borderRadius: "var(--r-md)",
                    cursor: "pointer",
                    background: agentId === a.id ? "var(--primary-soft)" : "transparent",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{TPL_LABEL[a.templateKey] || a.templateKey}</div>
                  </div>
                  <input
                    type="radio"
                    name="agent"
                    checked={agentId === a.id}
                    onChange={() => setAgentId(a.id)}
                    aria-label={`Escolher ${a.name}`}
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Filtro + mensagem */}
        {step === 2 && (
          <div className="col" style={{ gap: 14 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Nome da campanha</label>
              <div className="muted" style={{ fontSize: 12 }}>Pra você identificar depois. Ex: &quot;Feirão Maio 2026&quot;.</div>
              <input
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={100}
                placeholder="Feirão Maio 2026"
                style={{ marginTop: 6 }}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Tag dos contatos</label>
              <div className="muted" style={{ fontSize: 12 }}>O agente vai abordar contatos com essa tag no Spark Leads.</div>
              <input
                className="input"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={80}
                placeholder="ex: feirao_2026"
                style={{ marginTop: 6 }}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Mensagem (template)</label>
              <div className="muted" style={{ fontSize: 12 }}>
                Suporta variáveis: <code>{`{first_name}`}</code>, <code>{`{tags[0]}`}</code>, <code>{`{custom.slug}`}</code>.
              </div>
              <textarea
                className="textarea"
                rows={5}
                maxLength={3000}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="Oi {first_name}! Vi que você passou no feirão — posso te ajudar com a cotação?"
                style={{ marginTop: 6 }}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Intervalo entre envios (segundos)</label>
              <div className="muted" style={{ fontSize: 12 }}>Espalha no tempo pra não parecer disparo. Mín 30, máx 600. Default 90.</div>
              <input
                className="input"
                type="number"
                min={30}
                max={600}
                value={intervalSec}
                onChange={(e) => setIntervalSec(e.target.value)}
                style={{ marginTop: 6, width: 140 }}
              />
            </div>
          </div>
        )}

        {/* Step 3: Revisar */}
        {step === 3 && (
          <div className="col" style={{ gap: 14 }}>
            <div className="card card--flat" style={{ padding: 14, background: "var(--primary-soft)" }}>
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <AlertCircle size={16} style={{ color: "var(--primary-ink)", marginTop: 2 }} />
                <div style={{ fontSize: 12.5, color: "var(--primary-ink)", lineHeight: 1.5 }}>
                  <strong>Atenção:</strong> a campanha é criada em <strong>pausa</strong>. Pra disparar, abra o SparkBot e diga: <em>&quot;iniciar campanha {label || "<nome>"}&quot;</em>. Botões pra iniciar/pausar/cancelar direto aqui vêm no próximo deploy.
                </div>
              </div>
            </div>

            <Row label="Agente" value={selectedAgent ? `${selectedAgent.name} (${TPL_LABEL[selectedAgent.templateKey] || selectedAgent.templateKey})` : "—"} />
            <Row label="Nome" value={label || "—"} />
            <Row label="Tag" value={tag || "—"} />
            <Row label="Intervalo" value={`${intervalSec || 90}s entre envios`} />
            <div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>Mensagem</div>
              <div style={{ fontSize: 13, padding: 10, background: "var(--surface-2)", borderRadius: "var(--r-sm)", whiteSpace: "pre-wrap" }}>
                {template || "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer com navegação */}
      <div className="card-hd" style={{ borderTop: "1px solid var(--line)", borderBottom: "none", justifyContent: "space-between" }}>
        <button
          className="btn btn--quiet btn--sm"
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
          disabled={step === 1 || submitting}
        >
          <ChevronLeft /> Voltar
        </button>
        {step < 3 ? (
          <button
            className="btn btn--primary btn--sm"
            onClick={() => setStep((s) => (s + 1) as Step)}
            disabled={(step === 1 && !canAdvance1) || (step === 2 && !canAdvance2)}
          >
            Continuar <ChevronRight />
          </button>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={submit} disabled={submitting}>
            <Megaphone size={14} /> {submitting ? "Criando…" : "Criar campanha"}
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ paddingBottom: 6, borderBottom: "1px solid var(--line)" }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// Suprimir warning de não-uso quando Check vier a ser usado em iteração futura.
void Check;
