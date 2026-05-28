"use client";

/**
 * Recurring campaign wizard (Etapa 4.5 — Pedro 2026-05-28).
 *
 * 3 steps: agente · cron+filtro+template · revisar (com preview de próximos 5).
 * POST /api/hub/campaigns/recurring cria a row habilitada com next_run_at já
 * computado no timezone do agente (D2 default).
 *
 * Cron picker: presets comuns + opção custom pra avançado.
 */
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Repeat, AlertCircle } from "lucide-react";

export interface AgentChoice {
  id: string;
  name: string;
  templateKey: string;
}

interface CronPreset {
  label: string;
  cron: string;
  hint: string;
}

const CRON_PRESETS: CronPreset[] = [
  { label: "Toda segunda às 9h", cron: "0 9 * * 1", hint: "Bom pra começar a semana" },
  { label: "Todo dia útil às 9h", cron: "0 9 * * 1-5", hint: "Seg-sex" },
  { label: "Todo dia útil às 14h", cron: "0 14 * * 1-5", hint: "Seg-sex, tarde" },
  { label: "Todo dia às 9h", cron: "0 9 * * *", hint: "Incluindo fins de semana" },
  { label: "Todo dia 1 às 10h", cron: "0 10 1 * *", hint: "Mensal" },
];

const TPL_LABEL: Record<string, string> = {
  sales: "Vendas",
  recruitment: "Recrutamento",
  custom: "Personalizado",
};

type Step = 1 | 2 | 3;

export function RecurringWizard({ agents }: { agents: AgentChoice[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id || "");
  const [label, setLabel] = useState("");
  const [tag, setTag] = useState("");
  const [template, setTemplate] = useState("");
  const [cron, setCron] = useState(CRON_PRESETS[0].cron);
  const [customCron, setCustomCron] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [perRunCap, setPerRunCap] = useState("1000");
  const [submitting, setSubmitting] = useState(false);

  const selectedAgent = agents.find((a) => a.id === agentId);
  const effectiveCron = useCustom ? customCron.trim() : cron;

  const canAdvance1 = !!agentId;
  const canAdvance2 =
    label.trim().length > 0 &&
    tag.trim().length > 0 &&
    template.trim().length > 0 &&
    effectiveCron.split(/\s+/).length === 5;

  // Preview client-side: pequeno parser pra explicar o cron escolhido.
  const cronExplanation = useMemo(() => {
    const preset = CRON_PRESETS.find((p) => p.cron === effectiveCron);
    if (preset) return preset.label;
    const parts = effectiveCron.split(/\s+/);
    if (parts.length !== 5) return "Cron inválido (precisa de 5 campos)";
    return `Cron custom: ${effectiveCron}`;
  }, [effectiveCron]);

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch("/api/hub/campaigns/recurring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          label: label.trim(),
          tag: tag.trim(),
          template: template.trim(),
          cron_expression: effectiveCron,
          per_run_cap: Math.max(1, Math.min(50000, Number(perRunCap) || 1000)),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        next_run_at?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      toast.success("Recorrência criada e ativada");
      router.push("/hub/campaigns");
    } catch (err) {
      toast.error("Não consegui criar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
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
                {n === 1 ? "Agente" : n === 2 ? "Quando + mensagem" : "Revisar"}
              </span>
              {n < 3 && <ChevronRight size={14} style={{ color: "var(--ink-4)" }} />}
            </div>
          ))}
        </div>
      </div>

      <div className="card-body" style={{ padding: 20 }}>
        {step === 1 && (
          <div className="col" style={{ gap: 14 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Qual agente vai disparar?</div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
                Cada execução cria uma campanha-filho pelo agente escolhido. Disparos respeitam canal + horário silêncio dele.
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

        {step === 2 && (
          <div className="col" style={{ gap: 14 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Nome da recorrência</label>
              <input
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={100}
                placeholder="ex: Acompanhamento semanal leads frios"
                style={{ marginTop: 6 }}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Quando disparar?</label>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Horário no timezone do agente.
              </div>
              <div className="col" style={{ gap: 6 }}>
                {!useCustom && CRON_PRESETS.map((p) => (
                  <label
                    key={p.cron}
                    className="row between"
                    style={{
                      gap: 10,
                      padding: "8px 12px",
                      border: cron === p.cron ? "2px solid var(--primary)" : "1px solid var(--line)",
                      borderRadius: "var(--r-md)",
                      cursor: "pointer",
                      background: cron === p.cron ? "var(--primary-soft)" : "transparent",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13 }}>{p.label}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{p.hint}</div>
                    </div>
                    <input
                      type="radio"
                      name="cron"
                      checked={cron === p.cron}
                      onChange={() => setCron(p.cron)}
                    />
                  </label>
                ))}
                <label className="row" style={{ gap: 8, marginTop: 4, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={useCustom}
                    onChange={(e) => setUseCustom(e.target.checked)}
                  />
                  <span style={{ fontSize: 12.5 }}>Usar cron custom (avançado)</span>
                </label>
                {useCustom && (
                  <div className="col" style={{ gap: 4 }}>
                    <input
                      className="input"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                      placeholder="ex: 0 9 * * 1  (min hora dia mês dow)"
                      style={{ fontFamily: "monospace" }}
                    />
                    <div className="muted" style={{ fontSize: 11 }}>
                      Formato 5 campos POSIX. dow: 0=domingo, 6=sábado.
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Tag dos contatos</label>
              <input
                className="input"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={80}
                placeholder="ex: leads_frios"
                style={{ marginTop: 6 }}
              />
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                A lista é re-pesquisada no Spark Leads a cada disparo (não usa snapshot antigo).
              </div>
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Mensagem (template)</label>
              <textarea
                className="textarea"
                rows={5}
                maxLength={3000}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="Oi {first_name}! Faz um tempinho — quer dar continuidade?"
                style={{ marginTop: 6 }}
              />
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                Variáveis: {`{first_name}`}, {`{tags[0]}`}, {`{custom.slug}`}.
              </div>
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Hard cap por execução</label>
              <input
                className="input"
                type="number"
                min={1}
                max={50000}
                value={perRunCap}
                onChange={(e) => setPerRunCap(e.target.value)}
                style={{ marginTop: 6, width: 140 }}
              />
              <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                Proteção anti-spam: nunca dispara pra mais que esse número por execução, mesmo que o filtro pegue mais.
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="col" style={{ gap: 14 }}>
            <div className="card card--flat" style={{ padding: 14, background: "var(--primary-soft)" }}>
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <AlertCircle size={16} style={{ color: "var(--primary-ink)", marginTop: 2 }} />
                <div style={{ fontSize: 12.5, color: "var(--primary-ink)", lineHeight: 1.5 }}>
                  A recorrência fica <strong>ativa</strong> ao criar. Próximo disparo será calculado a partir de agora. Você pode pausar/remover a qualquer momento em /hub/campaigns.
                </div>
              </div>
            </div>

            <Row label="Agente" value={selectedAgent ? `${selectedAgent.name} (${TPL_LABEL[selectedAgent.templateKey] || selectedAgent.templateKey})` : "—"} />
            <Row label="Nome" value={label || "—"} />
            <Row label="Quando" value={cronExplanation} />
            <Row label="Tag" value={tag || "—"} />
            <Row label="Hard cap" value={`${perRunCap || 1000} contatos por execução`} />

            <div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>Mensagem</div>
              <div style={{ fontSize: 13, padding: 10, background: "var(--surface-2)", borderRadius: "var(--r-sm)", whiteSpace: "pre-wrap" }}>
                {template || "—"}
              </div>
            </div>
          </div>
        )}
      </div>

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
            <Repeat size={14} /> {submitting ? "Criando…" : "Criar recorrência"}
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
