"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Zap, Tag, GitBranch, Database, Image as ImageIcon, MessageSquare, PauseCircle, Webhook, Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AutomationRule, AutomationAction, AutomationTrigger, DataField } from "@/types/agent";

interface GHLPipeline { id: string; name: string; stages: { id: string; name: string; position: number }[]; }
interface GHLTag { id: string; name: string; }
interface GHLCustomField { id: string; name: string; fieldKey: string; isStandard?: boolean; }

interface MediaItem {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

const DEFAULT_EVENTS = [
  { value: "qualified", label: "Lead qualificado" },
  { value: "booked", label: "Agendamento realizado" },
  { value: "handed_off", label: "Transferido para humano" },
  { value: "disqualified", label: "Lead desqualificado" },
  { value: "stale", label: "Lead inativo" },
];

const OPERATORS = [
  { value: "any_value", label: "For preenchido com qualquer valor" },
  { value: "equals", label: "For igual a" },
  { value: "contains", label: "Contem" },
  { value: "matches_regex", label: "Bater com regex" },
];

const ACTION_TYPES = [
  { value: "add_tag", label: "Adicionar tag", icon: Tag },
  { value: "remove_tag", label: "Remover tag", icon: Tag },
  { value: "move_pipeline", label: "Mover no pipeline", icon: GitBranch },
  { value: "update_field", label: "Atualizar campo", icon: Database },
  { value: "send_media", label: "Enviar midia", icon: ImageIcon },
  { value: "send_text_fixed", label: "Enviar texto fixo", icon: MessageSquare },
  { value: "pause_ai", label: "Pausar IA", icon: PauseCircle },
  { value: "webhook", label: "Chamar webhook", icon: Webhook },
];

interface AutomationsEditorProps {
  rules: AutomationRule[];
  pipelines: GHLPipeline[];
  tags: GHLTag[];
  customFields: GHLCustomField[];
  dataFields: DataField[];
  agentId: string | null;
  onChange: (rules: AutomationRule[]) => void;
}

function triggerLabel(rule: AutomationRule): string {
  const t = rule.trigger;
  if (t && t.kind === "on_data_field_set") {
    const op = OPERATORS.find((o) => o.value === t.operator)?.label || t.operator;
    return `Campo "${t.field_key}" ${op}${t.value ? ` "${t.value}"` : ""}`;
  }
  const ev = t && t.kind === "event" ? t.event : rule.event;
  return rule.event_label || DEFAULT_EVENTS.find((e) => e.value === ev)?.label || ev || "evento";
}

export function AutomationsEditor({
  rules,
  pipelines,
  tags,
  customFields,
  dataFields,
  agentId,
  onChange,
}: AutomationsEditorProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [triggerKind, setTriggerKind] = useState<"event" | "on_data_field_set">("event");
  const [newEvent, setNewEvent] = useState("qualified");
  const [customEventLabel, setCustomEventLabel] = useState("");
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newOperator, setNewOperator] = useState<"any_value" | "equals" | "contains" | "matches_regex">("any_value");
  const [newValue, setNewValue] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);

  // Carrega biblioteca de midia do agente
  useEffect(() => {
    if (!agentId) return;
    fetch(`/api/media?agent_id=${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setMedia(data?.items || []))
      .catch(() => {});
  }, [agentId]);

  const uploadMedia = async (file: File) => {
    if (!agentId) return;
    setUploadingMedia(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("agent_id", agentId);
      const res = await fetch("/api/media", { method: "POST", body: fd });
      if (res.ok) {
        const data = await res.json();
        setMedia((prev) => [data.item, ...prev]);
      }
    } finally {
      setUploadingMedia(false);
    }
  };

  const deleteMedia = async (id: string) => {
    if (!agentId) return;
    await fetch(`/api/media?id=${id}&agent_id=${agentId}`, { method: "DELETE" });
    setMedia((prev) => prev.filter((m) => m.id !== id));
  };

  const addRule = () => {
    let trigger: AutomationTrigger;
    let legacyEvent: string | undefined;
    let legacyLabel: string | undefined;

    if (triggerKind === "event") {
      const isCustom = newEvent === "custom";
      const eventVal = isCustom ? customEventLabel.toLowerCase().replace(/\s+/g, "_") : newEvent;
      const eventLbl = isCustom ? customEventLabel : DEFAULT_EVENTS.find((e) => e.value === newEvent)?.label;
      trigger = { kind: "event", event: eventVal, event_label: eventLbl };
      legacyEvent = eventVal;
      legacyLabel = eventLbl;
    } else {
      if (!newFieldKey) return;
      trigger = {
        kind: "on_data_field_set",
        field_key: newFieldKey,
        operator: newOperator,
        value: newOperator === "any_value" ? undefined : newValue,
      };
    }

    const rule: AutomationRule = {
      id: crypto.randomUUID(),
      event: legacyEvent,
      event_label: legacyLabel,
      trigger,
      actions: [],
    };
    onChange([...rules, rule]);
    setShowAdd(false);
    setNewEvent("qualified");
    setCustomEventLabel("");
    setNewFieldKey("");
    setNewOperator("any_value");
    setNewValue("");
  };

  const removeRule = (id: string) => onChange(rules.filter((r) => r.id !== id));

  const addAction = (ruleId: string) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: [...r.actions, { type: "add_tag" as const }],
    } : r));
  };

  const updateAction = (ruleId: string, actionIdx: number, updates: Partial<AutomationAction>) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: r.actions.map((a, i) => i === actionIdx ? { ...a, ...updates } : a),
    } : r));
  };

  const removeAction = (ruleId: string, actionIdx: number) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: r.actions.filter((_, i) => i !== actionIdx),
    } : r));
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Configure acoes automaticas disparadas por eventos (qualified, booked...) ou por campos coletados (ex: quando &quot;estado&quot; virar &quot;brasil&quot;, envia uma imagem e adiciona uma tag).
      </p>

      {/* Lista de regras */}
      {rules.map((rule) => (
        <div key={rule.id} className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50">
            <div className="flex items-center gap-2 min-w-0">
              <Zap className="w-4 h-4 text-brand-500 flex-shrink-0" />
              <span className="text-sm font-medium flex-shrink-0">Quando:</span>
              <Badge variant="secondary" className="truncate">{triggerLabel(rule)}</Badge>
            </div>
            <button onClick={() => removeRule(rule.id)} className="text-gray-500 hover:text-red-500">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3 space-y-2">
            {rule.actions.length === 0 && (
              <p className="text-xs text-gray-500">Nenhuma acao configurada</p>
            )}

            {rule.actions.map((action, actionIdx) => {
              const selectedPipeline = pipelines.find((p) => p.id === action.pipeline_id);
              return (
                <div key={actionIdx} className="flex items-start gap-2 p-2 bg-gray-50 border border-gray-100 rounded-lg">
                  <Select
                    value={action.type}
                    onValueChange={(v) => updateAction(rule.id, actionIdx, { type: v as AutomationAction["type"] })}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs flex-shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((at) => (
                        <SelectItem key={at.value} value={at.value}>{at.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <div className="flex-1 min-w-0 space-y-1.5">
                    {(action.type === "add_tag" || action.type === "remove_tag") && (
                      <Select
                        value={action.tag || ""}
                        onValueChange={(v) => updateAction(rule.id, actionIdx, { tag: v })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Selecione tag..." />
                        </SelectTrigger>
                        <SelectContent>
                          {tags.map((t) => (
                            <SelectItem key={t.id || t.name} value={t.name}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    {action.type === "move_pipeline" && (
                      <div className="flex gap-2">
                        <Select
                          value={action.pipeline_id || ""}
                          onValueChange={(v) => updateAction(rule.id, actionIdx, { pipeline_id: v, stage_id: "" })}
                        >
                          <SelectTrigger className="w-40 h-8 text-xs">
                            <SelectValue placeholder="Pipeline..." />
                          </SelectTrigger>
                          <SelectContent>
                            {pipelines.map((p) => (
                              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedPipeline && (
                          <Select
                            value={action.stage_id || ""}
                            onValueChange={(v) => updateAction(rule.id, actionIdx, { stage_id: v })}
                          >
                            <SelectTrigger className="flex-1 h-8 text-xs">
                              <SelectValue placeholder="Estagio..." />
                            </SelectTrigger>
                            <SelectContent>
                              {selectedPipeline.stages.sort((a, b) => a.position - b.position).map((s) => (
                                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}

                    {action.type === "update_field" && (
                      <div className="flex gap-2">
                        <Select
                          value={action.field_key || ""}
                          onValueChange={(v) => updateAction(rule.id, actionIdx, { field_key: v })}
                        >
                          <SelectTrigger className="w-40 h-8 text-xs">
                            <SelectValue placeholder="Campo..." />
                          </SelectTrigger>
                          <SelectContent>
                            {customFields.map((f) => (
                              <SelectItem key={f.id} value={f.fieldKey || f.id}>{f.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={action.field_value || ""}
                          onChange={(e) => updateAction(rule.id, actionIdx, { field_value: e.target.value })}
                          placeholder="Valor..."
                          className="flex-1 h-8 text-xs"
                        />
                      </div>
                    )}

                    {action.type === "send_media" && (
                      <div className="space-y-1.5">
                        <Select
                          value={action.media_id || ""}
                          onValueChange={(v) => updateAction(rule.id, actionIdx, { media_id: v })}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder={media.length === 0 ? "Biblioteca vazia — faca upload abaixo" : "Selecione midia..."} />
                          </SelectTrigger>
                          <SelectContent>
                            {media.map((m) => (
                              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={action.media_caption || ""}
                          onChange={(e) => updateAction(rule.id, actionIdx, { media_caption: e.target.value })}
                          placeholder="Legenda (opcional)"
                          className="h-8 text-xs"
                        />
                      </div>
                    )}

                    {action.type === "send_text_fixed" && (
                      <Textarea
                        value={action.text || ""}
                        onChange={(e) => updateAction(rule.id, actionIdx, { text: e.target.value })}
                        placeholder="Texto exato a enviar..."
                        rows={2}
                        className="text-xs"
                      />
                    )}

                    {action.type === "pause_ai" && (
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          value={action.pause_minutes ?? 0}
                          onChange={(e) => updateAction(rule.id, actionIdx, { pause_minutes: Number(e.target.value) })}
                          className="w-24 h-8 text-xs"
                        />
                        <span className="text-xs text-gray-500">minutos (0 = indefinido)</span>
                      </div>
                    )}

                    {action.type === "webhook" && (
                      <Input
                        value={action.webhook_url || ""}
                        onChange={(e) => updateAction(rule.id, actionIdx, { webhook_url: e.target.value })}
                        placeholder="https://..."
                        className="h-8 text-xs"
                      />
                    )}
                  </div>

                  <button onClick={() => removeAction(rule.id, actionIdx)} className="text-gray-500 hover:text-red-500 flex-shrink-0 mt-1">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}

            <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => addAction(rule.id)}>
              <Plus className="w-3 h-3 mr-1" />
              Adicionar acao
            </Button>
          </div>
        </div>
      ))}

      {/* Adicionar regra */}
      {showAdd ? (
        <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 space-y-3">
          <div>
            <Label className="text-xs">Tipo de gatilho</Label>
            <Select value={triggerKind} onValueChange={(v) => setTriggerKind(v as "event" | "on_data_field_set")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="event">Evento da conversa</SelectItem>
                <SelectItem value="on_data_field_set">Campo coletado (dado)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {triggerKind === "event" ? (
            <>
              <Label className="text-xs">Evento disparador</Label>
              <Select value={newEvent} onValueChange={setNewEvent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_EVENTS.map((e) => (
                    <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                  ))}
                  <SelectItem value="custom">Evento personalizado...</SelectItem>
                </SelectContent>
              </Select>
              {newEvent === "custom" && (
                <Input
                  value={customEventLabel}
                  onChange={(e) => setCustomEventLabel(e.target.value)}
                  placeholder="Nome do evento (ex: primeiro contato)"
                />
              )}
            </>
          ) : (
            <>
              <Label className="text-xs">Campo (de dados coletados)</Label>
              <Select value={newFieldKey} onValueChange={setNewFieldKey}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione um campo..." />
                </SelectTrigger>
                <SelectContent>
                  {dataFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>{f.label} ({f.key})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label className="text-xs">Condicao</Label>
              <Select value={newOperator} onValueChange={(v) => setNewOperator(v as typeof newOperator)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newOperator !== "any_value" && (
                <>
                  <Label className="text-xs">Valor</Label>
                  <Input
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    placeholder={newOperator === "matches_regex" ? "regex (ex: ^bras)" : "Ex: brasil"}
                  />
                </>
              )}
            </>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={addRule}
              disabled={
                (triggerKind === "event" && newEvent === "custom" && !customEventLabel) ||
                (triggerKind === "on_data_field_set" && !newFieldKey)
              }
            >
              Criar regra
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowAdd(true)} className="w-full">
          <Plus className="w-3.5 h-3.5 mr-2" />
          Adicionar automacao
        </Button>
      )}

      {/* Biblioteca de midia */}
      {agentId && (
        <div className="pt-4 border-t border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div>
              <Label className="text-sm font-semibold text-gray-900">Biblioteca de midia</Label>
              <p className="text-xs text-gray-500">Arquivos disponiveis para acoes &quot;Enviar midia&quot;. Imagens, audios, videos ou PDFs ate 25 MB.</p>
            </div>
            <label className="cursor-pointer">
              <input
                type="file"
                className="hidden"
                accept="image/*,audio/*,video/*,application/pdf"
                disabled={uploadingMedia}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadMedia(f);
                  e.target.value = "";
                }}
              />
              <Button size="sm" variant="outline" asChild>
                <span className="cursor-pointer">
                  {uploadingMedia ? (
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-3.5 h-3.5 mr-2" />
                  )}
                  Upload
                </span>
              </Button>
            </label>
          </div>
          {media.length === 0 ? (
            <p className="text-xs text-gray-400 italic py-3">Nenhum arquivo ainda. Faca upload para usar nas acoes.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {media.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 p-2 border border-gray-200 bg-white rounded-lg">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded bg-brand-50 border border-brand-100 flex items-center justify-center flex-shrink-0">
                      <ImageIcon className="w-3.5 h-3.5 text-brand-600" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-900 truncate">{m.name}</div>
                      <div className="text-[10px] text-gray-400">{(m.size_bytes / 1024).toFixed(0)} KB · {m.mime_type}</div>
                    </div>
                  </div>
                  <button onClick={() => deleteMedia(m.id)} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
