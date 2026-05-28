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
 *
 * Etapa 4.4 (Pedro 2026-05-28): adiciona modo "Sequência multi-toque" — toggle
 * no step 2 que troca o template único por um editor de N passos (até 10), cada
 * um com delay_days (step 1 sempre 0). API aceita `sequence_steps[]` opcional.
 * Pause-on-reply default true por step.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Check, Megaphone, AlertCircle, Plus, Trash2, Layers, Split, Users, Loader2 } from "lucide-react";

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

interface SequenceStep {
  template: string;
  delay_days: number;
  pause_on_reply: boolean;
}

interface AbVariant {
  template: string;
  weight: number;
}

const MAX_SEQUENCE_STEPS = 10;
const MAX_AB_VARIANTS = 5;

export function CampaignWizard({ agents }: { agents: AgentChoice[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id || "");
  const [label, setLabel] = useState("");
  const [tag, setTag] = useState("");
  const [template, setTemplate] = useState("");
  const [intervalSec, setIntervalSec] = useState("90");
  const [submitting, setSubmitting] = useState(false);

  // Etapa 4.4: modo sequência. Toggle off = single template como antes.
  const [sequenceMode, setSequenceMode] = useState(false);
  // Step 1 sempre delay=0 (regra de API). Steps adicionais começam com 3 dias.
  const [sequenceSteps, setSequenceSteps] = useState<SequenceStep[]>([
    { template: "", delay_days: 0, pause_on_reply: true },
  ]);

  // Etapa 4.7: modo A/B. Mutuamente exclusivo com sequenceMode no MVP.
  const [abMode, setAbMode] = useState(false);
  const [abVariants, setAbVariants] = useState<AbVariant[]>([
    { template: "", weight: 50 },
    { template: "", weight: 50 },
  ]);

  const selectedAgent = agents.find((a) => a.id === agentId);

  const canAdvance1 = !!agentId;
  const canAdvance2 = abMode
    ? label.trim().length > 0 &&
      tag.trim().length > 0 &&
      abVariants.length >= 2 &&
      abVariants.every((v) => v.template.trim().length > 0 && v.weight >= 1)
    : sequenceMode
    ? label.trim().length > 0 &&
      tag.trim().length > 0 &&
      sequenceSteps.length >= 1 &&
      sequenceSteps.every((s) => s.template.trim().length > 0) &&
      sequenceSteps.slice(1).every((s) => s.delay_days >= 1)
    : label.trim().length > 0 && tag.trim().length > 0 && template.trim().length > 0;

  function updateStep(idx: number, patch: Partial<SequenceStep>) {
    setSequenceSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function addStep() {
    if (sequenceSteps.length >= MAX_SEQUENCE_STEPS) return;
    // Default 3 dias entre toques (sweet spot pra outreach).
    setSequenceSteps((prev) => [...prev, { template: "", delay_days: 3, pause_on_reply: true }]);
  }

  function removeStep(idx: number) {
    // Nunca remove o step 1 (precisa de pelo menos 1).
    if (idx === 0) return;
    setSequenceSteps((prev) => prev.filter((_, i) => i !== idx));
  }

  // Quando liga o modo sequência, herda o template do textarea como step 1.
  function toggleSequenceMode(on: boolean) {
    setSequenceMode(on);
    if (on) setAbMode(false); // mutuamente exclusivo (4.7)
    if (on && template.trim().length > 0 && sequenceSteps[0].template.trim().length === 0) {
      updateStep(0, { template });
    }
    if (!on && sequenceSteps[0].template.trim().length > 0 && template.trim().length === 0) {
      setTemplate(sequenceSteps[0].template);
    }
  }

  // Etapa 4.7: toggle A/B. Mutuamente exclusivo com sequência. Herda template
  // do textarea como variant A se ainda não preenchido.
  function toggleAbMode(on: boolean) {
    setAbMode(on);
    if (on) setSequenceMode(false);
    if (on && template.trim().length > 0 && abVariants[0].template.trim().length === 0) {
      setAbVariants((prev) => prev.map((v, i) => (i === 0 ? { ...v, template } : v)));
    }
    if (!on && abVariants[0].template.trim().length > 0 && template.trim().length === 0) {
      setTemplate(abVariants[0].template);
    }
  }

  function updateVariant(idx: number, patch: Partial<AbVariant>) {
    setAbVariants((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  }

  function addVariant() {
    if (abVariants.length >= MAX_AB_VARIANTS) return;
    setAbVariants((prev) => [...prev, { template: "", weight: 50 }]);
  }

  function removeVariant(idx: number) {
    if (abVariants.length <= 2) return; // mínimo 2 pra ser A/B
    setAbVariants((prev) => prev.filter((_, i) => i !== idx));
  }

  // Total de weight pra mostrar % normalizado no preview.
  const abTotalWeight = abVariants.reduce((sum, v) => sum + Math.max(1, v.weight), 0);

  // F21 (Pedro 2026-05-28): preview de count de contatos com a tag.
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<{
    count: number;
    capped: boolean;
    sample_names: string[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Invalida preview quando muda tag/agente.
  function resetPreview() {
    setPreview(null);
    setPreviewError(null);
  }
  async function loadPreview() {
    if (!agentId || tag.trim().length === 0) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/hub/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, tag: tag.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "falha");
      }
      setPreview({
        count: json.count || 0,
        capped: !!json.capped,
        sample_names: json.sample_names || [],
      });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "falha desconhecida");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    try {
      const templateField = abMode
        ? abVariants[0].template.trim()
        : sequenceMode
        ? sequenceSteps[0].template.trim()
        : template.trim();
      const payload: Record<string, unknown> = {
        agent_id: agentId,
        label: label.trim(),
        tag: tag.trim(),
        template: templateField,
        interval_seconds: Number(intervalSec) || 90,
      };
      if (sequenceMode && sequenceSteps.length > 0) {
        payload.sequence_steps = sequenceSteps.map((s) => ({
          template: s.template.trim(),
          delay_days: s.delay_days,
          pause_on_reply: s.pause_on_reply,
        }));
      }
      if (abMode && abVariants.length >= 2) {
        payload.ab_variants = abVariants.map((v) => ({
          template: v.template.trim(),
          weight: Math.max(1, Math.min(100, v.weight)),
        }));
      }
      const res = await fetch("/api/hub/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "falha");
      }
      toast.success(
        abMode
          ? `Campanha A/B com ${abVariants.length} variantes criada — ative pra começar`
          : sequenceMode
          ? `Sequência de ${sequenceSteps.length} toques criada em pausa — ative pelo SparkBot`
          : "Campanha criada em pausa — ative pelo SparkBot pra iniciar"
      );
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
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "stretch" }}>
                <input
                  className="input"
                  value={tag}
                  onChange={(e) => { setTag(e.target.value); resetPreview(); }}
                  maxLength={80}
                  placeholder="ex: feirao_2026"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={loadPreview}
                  disabled={previewLoading || tag.trim().length === 0 || !agentId}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {previewLoading ? <Loader2 size={14} className="spin" /> : <Users size={14} />}
                  {previewLoading ? " Buscando…" : " Quantos?"}
                </button>
              </div>
              {/* F21: feedback do preview */}
              {preview && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 12px",
                    background: preview.count === 0 ? "#fef3c7" : preview.count >= 5000 ? "#fee2e2" : "var(--primary-soft)",
                    borderRadius: 4,
                    fontSize: 12.5,
                  }}
                >
                  {preview.count === 0 ? (
                    <span style={{ color: "#92400e" }}>
                      ⚠️ Nenhum contato encontrado com a tag <strong>&quot;{tag.trim()}&quot;</strong>. Confirme a grafia no Spark Leads.
                    </span>
                  ) : preview.count >= 5000 ? (
                    <span style={{ color: "#7f1d1d" }}>
                      ⚠️ <strong>{preview.count.toLocaleString("pt-BR")}+</strong> contatos (cap atingido). Em escala desse tamanho, revise tag pra refinar antes.
                    </span>
                  ) : (
                    <span style={{ color: "var(--primary-ink)" }}>
                      ✅ <strong>{preview.count.toLocaleString("pt-BR")}</strong> contato{preview.count > 1 ? "s" : ""} encontrado{preview.count > 1 ? "s" : ""}
                      {preview.sample_names.length > 0 && (
                        <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                          (ex: {preview.sample_names.slice(0, 3).join(", ")}{preview.sample_names.length > 3 ? "…" : ""})
                        </span>
                      )}
                    </span>
                  )}
                </div>
              )}
              {previewError && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 12px",
                    background: "#fee2e2",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "#7f1d1d",
                  }}
                >
                  Não consegui buscar: {previewError}
                </div>
              )}
            </div>

            {/* Etapa 4.4 + 4.7: toggles de modo. Mutuamente exclusivos no MVP. */}
            <div className="col" style={{ gap: 8 }}>
              <div
                className="row between"
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-md)",
                  background: sequenceMode ? "var(--primary-soft)" : "transparent",
                  gap: 12,
                }}
              >
                <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <Layers size={16} style={{ color: sequenceMode ? "var(--primary-ink)" : "var(--ink-3)", marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>Sequência multi-toque</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      N mensagens com intervalo de dias. Pausa quando o contato responde.
                    </div>
                  </div>
                </div>
                <label className="row" style={{ gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={sequenceMode}
                    onChange={(e) => toggleSequenceMode(e.target.checked)}
                    disabled={abMode}
                    aria-label="Ativar sequência multi-toque"
                  />
                  <span style={{ fontSize: 12 }}>{sequenceMode ? "Ativada" : "Desativada"}</span>
                </label>
              </div>
              <div
                className="row between"
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-md)",
                  background: abMode ? "var(--primary-soft)" : "transparent",
                  gap: 12,
                }}
              >
                <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <Split size={16} style={{ color: abMode ? "var(--primary-ink)" : "var(--ink-3)", marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500 }}>Testar variações A/B</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      2-5 versões da mensagem com peso configurável. Sorteia por contato.
                    </div>
                  </div>
                </div>
                <label className="row" style={{ gap: 6, alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={abMode}
                    onChange={(e) => toggleAbMode(e.target.checked)}
                    disabled={sequenceMode}
                    aria-label="Ativar variações A/B"
                  />
                  <span style={{ fontSize: 12 }}>{abMode ? "Ativada" : "Desativada"}</span>
                </label>
              </div>
              {sequenceMode && abMode && (
                <div className="muted" style={{ fontSize: 11.5, fontStyle: "italic" }}>
                  Os modos são mutuamente exclusivos — escolha um.
                </div>
              )}
            </div>

            {!sequenceMode && !abMode && (
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
            )}

            {/* Etapa 4.7: editor de variants A/B. */}
            {abMode && (
              <div className="col" style={{ gap: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Cada contato recebe UMA variante, sorteada por peso normalizado. Atualmente totalizando {abTotalWeight} pontos.
                </div>
                {abVariants.map((v, idx) => {
                  const pct = abTotalWeight > 0 ? Math.round((Math.max(1, v.weight) / abTotalWeight) * 100) : 0;
                  return (
                    <div
                      key={idx}
                      className="card card--flat"
                      style={{
                        padding: 12,
                        border: "1px solid var(--line)",
                        borderRadius: "var(--r-md)",
                        background: "var(--surface-2)",
                      }}
                    >
                      <div className="row between" style={{ marginBottom: 8 }}>
                        <div className="row" style={{ gap: 8, alignItems: "center" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 24,
                              height: 24,
                              borderRadius: 12,
                              background: "var(--primary)",
                              color: "#fff",
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            {String.fromCharCode(65 + idx)}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>Variante {String.fromCharCode(65 + idx)}</span>
                          <span className="muted" style={{ fontSize: 12 }}>(~{pct}% dos contatos)</span>
                        </div>
                        {abVariants.length > 2 && (
                          <button
                            type="button"
                            className="btn btn--quiet btn--sm"
                            onClick={() => removeVariant(idx)}
                            aria-label={`Remover variante ${String.fromCharCode(65 + idx)}`}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <textarea
                        className="textarea"
                        rows={4}
                        maxLength={3000}
                        value={v.template}
                        onChange={(e) => updateVariant(idx, { template: e.target.value })}
                        placeholder={`Oi {first_name}! (versão ${String.fromCharCode(65 + idx)})`}
                        aria-label={`Texto da variante ${String.fromCharCode(65 + idx)}`}
                      />

                      <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 10 }}>
                        <span className="muted" style={{ fontSize: 12 }}>Peso</span>
                        <input
                          type="range"
                          min={1}
                          max={100}
                          value={v.weight}
                          onChange={(e) => updateVariant(idx, { weight: Number(e.target.value) || 1 })}
                          style={{ flex: 1 }}
                          aria-label={`Peso da variante ${String.fromCharCode(65 + idx)}`}
                        />
                        <span className="tnum" style={{ fontSize: 12.5, minWidth: 32, textAlign: "right" }}>
                          {v.weight}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {abVariants.length < MAX_AB_VARIANTS && (
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={addVariant}
                    style={{ alignSelf: "flex-start" }}
                  >
                    <Plus size={14} /> Adicionar variante
                  </button>
                )}
              </div>
            )}

            {sequenceMode && (
              <div className="col" style={{ gap: 12 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Step 1 sai junto com a ativação da campanha. Steps seguintes esperam o delay (em dias) após o step anterior. Máximo {MAX_SEQUENCE_STEPS} passos.
                </div>
                {sequenceSteps.map((s, idx) => (
                  <div
                    key={idx}
                    className="card card--flat"
                    style={{
                      padding: 12,
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r-md)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <div className="row between" style={{ marginBottom: 8 }}>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            borderRadius: 11,
                            background: "var(--primary)",
                            color: "#fff",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {idx + 1}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>
                          {idx === 0 ? "Mensagem inicial" : `Toque ${idx + 1}`}
                        </span>
                      </div>
                      {idx > 0 && (
                        <button
                          type="button"
                          className="btn btn--quiet btn--sm"
                          onClick={() => removeStep(idx)}
                          aria-label={`Remover toque ${idx + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    {idx === 0 ? (
                      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                        Sai junto com a ativação (delay 0).
                      </div>
                    ) : (
                      <div style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 12.5, fontWeight: 500 }}>Dias após o toque anterior</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={90}
                          value={s.delay_days}
                          onChange={(e) => updateStep(idx, { delay_days: Math.max(1, Math.min(90, Number(e.target.value) || 1)) })}
                          style={{ marginTop: 4, width: 100 }}
                        />
                      </div>
                    )}

                    <textarea
                      className="textarea"
                      rows={4}
                      maxLength={3000}
                      value={s.template}
                      onChange={(e) => updateStep(idx, { template: e.target.value })}
                      placeholder={idx === 0 ? "Oi {first_name}! ..." : "Oi {first_name}, dei uma olhada e..."}
                      aria-label={`Texto do toque ${idx + 1}`}
                    />

                    <label className="row" style={{ gap: 6, alignItems: "center", marginTop: 8, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={s.pause_on_reply}
                        onChange={(e) => updateStep(idx, { pause_on_reply: e.target.checked })}
                        aria-label="Pausar próximos toques se contato responder"
                      />
                      <span style={{ fontSize: 12 }} className="muted">
                        Pausar próximos toques se contato responder
                      </span>
                    </label>
                  </div>
                ))}

                {sequenceSteps.length < MAX_SEQUENCE_STEPS && (
                  <button
                    type="button"
                    className="btn btn--quiet btn--sm"
                    onClick={addStep}
                    style={{ alignSelf: "flex-start" }}
                  >
                    <Plus size={14} /> Adicionar toque
                  </button>
                )}
              </div>
            )}

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
            <Row
              label="Modo"
              value={
                abMode
                  ? `A/B ${abVariants.length} variantes`
                  : sequenceMode
                  ? `Sequência ${sequenceSteps.length} toques`
                  : "Mensagem única"
              }
            />

            {!sequenceMode && !abMode && (
              <div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 4 }}>Mensagem</div>
                <div style={{ fontSize: 13, padding: 10, background: "var(--surface-2)", borderRadius: "var(--r-sm)", whiteSpace: "pre-wrap" }}>
                  {template || "—"}
                </div>
              </div>
            )}

            {abMode && (
              <div className="col" style={{ gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Variantes A/B</div>
                {abVariants.map((v, idx) => {
                  const pct = abTotalWeight > 0 ? Math.round((Math.max(1, v.weight) / abTotalWeight) * 100) : 0;
                  return (
                    <div
                      key={idx}
                      style={{
                        padding: 10,
                        background: "var(--surface-2)",
                        borderRadius: "var(--r-sm)",
                        borderLeft: "3px solid var(--primary)",
                      }}
                    >
                      <div className="row" style={{ gap: 8, marginBottom: 6, alignItems: "center" }}>
                        <strong style={{ fontSize: 12.5 }}>Variante {String.fromCharCode(65 + idx)}</strong>
                        <span className="muted" style={{ fontSize: 12 }}>
                          peso {v.weight} · ~{pct}%
                        </span>
                      </div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                        {v.template || "—"}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {sequenceMode && (
              <div className="col" style={{ gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Sequência de toques</div>
                {sequenceSteps.map((s, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: 10,
                      background: "var(--surface-2)",
                      borderRadius: "var(--r-sm)",
                      borderLeft: "3px solid var(--primary)",
                    }}
                  >
                    <div className="row" style={{ gap: 8, marginBottom: 6, alignItems: "center" }}>
                      <strong style={{ fontSize: 12.5 }}>Toque {idx + 1}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {idx === 0 ? "imediato" : `+${s.delay_days} ${s.delay_days === 1 ? "dia" : "dias"}`}
                      </span>
                      {s.pause_on_reply && (
                        <span className="muted" style={{ fontSize: 11 }}>
                          · pausa se responder
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                      {s.template || "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
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
