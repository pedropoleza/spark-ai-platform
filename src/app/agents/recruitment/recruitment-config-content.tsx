"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Save, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToneSliders } from "@/components/agents/sales/tone-sliders";
import { ObjectiveSelector } from "@/components/agents/sales/objective-selector";
import { DataFieldsEditor } from "@/components/agents/sales/data-fields-editor";
import { AgentTester } from "@/components/agents/sales/agent-tester";
import { FollowUpConfigEditor } from "@/components/agents/sales/follow-up-config";
import { TargetingRulesEditor } from "@/components/agents/sales/targeting-rules-editor";
import { WorkingHoursEditor } from "@/components/agents/sales/working-hours-editor";
import { NotificationsConfigEditor } from "@/components/agents/sales/notifications-config";
import { ChannelSelector } from "@/components/agents/sales/channel-selector";
import { PersonalityEditor } from "@/components/agents/sales/personality-editor";
import { TimezoneConfigEditor } from "@/components/agents/sales/timezone-config";
import { PostBookingConfigEditor } from "@/components/agents/sales/post-booking-config";
import { AutomationsEditor } from "@/components/agents/sales/automations-editor";
import { KnowledgeBaseEditor } from "@/components/agents/sales/knowledge-base-editor";
import { DeactivationRulesEditor } from "@/components/agents/sales/deactivation-rules-editor";
import { MediaFeaturesEditor } from "@/components/agents/sales/media-features-editor";
import { useGHLData } from "@/hooks/use-ghl-data";
import { AI_MODELS, CONVERSATION_TEMPLATES } from "@/lib/utils/constants";
import type { AgentConfig, AgentObjective, AgentPersonality, PostBookingConfig, DataField, FollowUpConfig, TargetingRule, WorkingHoursConfig, TimezoneConfig, NotificationsConfig, AutomationRule, DeactivationRule, CommunicationChannel } from "@/types/agent";

type ConfigForm = Omit<AgentConfig, "id" | "agent_id" | "created_at" | "updated_at">;

const defaultConfig: ConfigForm = {
  personality: {
    name: "Bruno",
    identity_mode: "human",
    greeting_style: "Oii {name}, tudo bem?",
    farewell_style: "Se em outro momento fizer sentido, pode me chamar por aqui!",
    language: "pt-BR",
    persona_description: "Brasileiro, mora na Florida. Tom casual e amigável. Conversa como se fosse pelo WhatsApp. Cria conexão humana antes de tudo.",
  },
  targeting_rules: [],
  enabled_channels: ["SMS", "WhatsApp"],
  calendar_id: null,
  tone_creativity: 70,
  tone_formality: 10,
  tone_naturalness: 90,
  tone_aggressiveness: 40,
  objective: "qualification_and_booking",
  post_booking: {
    behavior: "stop_and_handoff",
    handoff_message: "Perfeito! Você vai receber a confirmação.",
    allow_reschedule: true,
  },
  data_fields: [
    { key: "full_name", label: "Nome completo", required: true, type: "text", skip_if_filled: true },
    { key: "state", label: "Estado", required: true, type: "text", skip_if_filled: true },
    { key: "work_permit", label: "Social Security / Permissão de trabalho", required: true, type: "boolean", skip_if_filled: false },
  ],
  ai_model: "gpt-4.1-mini",
  custom_instructions: "",
  knowledge_base_instructions: "",
  system_prompt_override: null,
  debounce_seconds: 15,
  max_messages_per_conversation: 50,
  working_hours: {
    enabled: false,
    timezone: "America/New_York",
    mode: "only_during" as const,
    schedule: {
      monday: { enabled: true, start: "09:00", end: "21:00" },
      tuesday: { enabled: true, start: "09:00", end: "21:00" },
      wednesday: { enabled: true, start: "09:00", end: "21:00" },
      thursday: { enabled: true, start: "09:00", end: "21:00" },
      friday: { enabled: true, start: "09:00", end: "21:00" },
      saturday: { enabled: true, start: "10:00", end: "18:00" },
      sunday: { enabled: false, start: "10:00", end: "15:00" },
    },
  },
  follow_up_config: {
    enabled: true,
    mode: "ai_auto",
    intensity: 6,
    max_attempts: 5,
    min_delay_minutes: 30,
    max_delay_minutes: 10080,
    custom_prompt: "Retome a conversa de forma leve, focando em despertar curiosidade sobre a oportunidade.",
    manual_steps: [],
  },
  timezone_config: {
    use_location_default: true,
    custom_timezone: "",
    confirm_before_booking: false,
    auto_detect_from_state: true,
  },
  notifications: {
    on_qualified: false,
    on_booked: true,
    on_handed_off: false,
    on_error: false,
    notification_email: "",
  },
  automations: [],
  deactivation_rules: [],
  handoff_messages: [],
  auto_pause_on_human_message: true,
  // Media features
  enable_audio_transcription: false,
  enable_image_analysis: false,
  enable_pdf_reading: false,
  enable_summary_notes: false,
  // Post-sales specialist/CS fields
  specialist_name: "",
  specialist_role: "responsável de atendimento",
  check_legal_docs: false,
  preferred_time_slot: "afternoon_evening",
};

export function RecruitmentConfigContent() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get("id");
  const [config, setConfig] = useState<ConfigForm>(defaultConfig);
  const [savedConfig, setSavedConfig] = useState<ConfigForm>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const isDirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const ghl = useGHLData();

  const fetchConfig = useCallback(async () => {
    if (!agentId) { setLoading(false); return; }
    try {
      const response = await fetch(`/api/agents/${agentId}/config`);
      if (response.ok) {
        const data = await response.json();
        if (data.config) {
          const dbConfig = Object.fromEntries(
            Object.entries(data.config).filter(([, v]) => v != null)
          );
          const merged = { ...defaultConfig, ...dbConfig };
          setConfig(merged);
          setSavedConfig(merged);
        }
      }
    } catch (error) {
      console.error("Erro ao buscar config:", error);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const handleSave = async () => {
    if (!agentId) return;
    setSaving(true); setSaved(false);
    try {
      const res = await fetch(`/api/agents/${agentId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSaved(true);
        setSavedConfig(config);
        toast.success("Configurações salvas com sucesso!", {
          description: "Todas as regras foram atualizadas.",
          duration: 4000,
        });
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Erro ao salvar configurações", {
          description: data.error || `Erro ${res.status}`,
          duration: 6000,
        });
      }
    } catch (error) {
      console.error("Erro ao salvar config:", error);
      toast.error("Erro de conexão", {
        description: "Não foi possível salvar. Verifique sua conexão.",
        duration: 6000,
      });
    }
    finally { setSaving(false); }
  };

  const updateConfig = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <PageWrapper title="Agente de Recrutamento" backHref="/dashboard">
        <Skeleton className="h-64" />
      </PageWrapper>
    );
  }

  return (
    <PageWrapper
      title="Agente de Recrutamento"
      subtitle="Configure como o agente interage com clientes já existentes"
      backHref="/dashboard"
      actions={
        <Button onClick={handleSave} disabled={saving || !agentId} variant={saved ? "outline" : "default"} className={saved ? "border-green-500 text-green-600" : ""}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4 mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          {saving ? "Salvando..." : saved ? "Salvo!" : isDirty ? "Salvar *" : "Salvar"}
          {isDirty && !saving && !saved && (
            <span className="ml-1.5 w-2 h-2 rounded-full bg-amber-400 inline-block" />
          )}
        </Button>
      }
    >
      <Tabs defaultValue="targeting" className="animate-fade-in">
        <TabsList>
          <TabsTrigger value="targeting">Segmentação</TabsTrigger>
          <TabsTrigger value="behavior">Comportamento</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="context">Contexto</TabsTrigger>
          <TabsTrigger value="test">Teste</TabsTrigger>
          <TabsTrigger value="advanced">Avançado</TabsTrigger>
        </TabsList>

        {/* SEGMENTACAO */}
        <TabsContent value="targeting">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Regras de ativação</CardTitle>
                <CardDescription>Defina quando o agente de recrutamento deve ser ativado</CardDescription>
              </CardHeader>
              <CardContent>
                <TargetingRulesEditor rules={config.targeting_rules} pipelines={ghl.pipelines} tags={ghl.tags} customFields={ghl.customFields} loading={ghl.loading} onChange={(rules: TargetingRule[]) => updateConfig("targeting_rules", rules)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Calendário</CardTitle><CardDescription>Calendário para agendamento de entrevistas</CardDescription></CardHeader>
              <CardContent>
                <Label>Calendário</Label>
                {ghl.loading ? <Skeleton className="h-10 mt-1.5" /> : (
                  <Select value={config.calendar_id || ""} onValueChange={(v) => updateConfig("calendar_id", v || null)}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>{ghl.calendars.map((c) => (<SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>))}</SelectContent>
                  </Select>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Canais</CardTitle></CardHeader>
              <CardContent>
                <ChannelSelector selected={config.enabled_channels} onChange={(channels: CommunicationChannel[]) => updateConfig("enabled_channels", channels)} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* COMPORTAMENTO */}
        <TabsContent value="behavior">
          <div className="grid gap-6">
            <Card>
              <CardHeader><CardTitle>Personalidade</CardTitle><CardDescription>Defina o nome e identidade do recrutador</CardDescription></CardHeader>
              <CardContent>
                <PersonalityEditor personality={config.personality} onChange={(v: AgentPersonality) => updateConfig("personality", v)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Objetivo do agente</CardTitle></CardHeader>
              <CardContent>
                <ObjectiveSelector value={config.objective} onChange={(v) => updateConfig("objective", v as AgentObjective)} />
              </CardContent>
            </Card>
            {config.objective !== "qualification_only" && (
              <Card>
                <CardHeader><CardTitle>Apos o agendamento</CardTitle></CardHeader>
                <CardContent>
                  <PostBookingConfigEditor config={config.post_booking} onChange={(v: PostBookingConfig) => updateConfig("post_booking", v)} />
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader><CardTitle>Dados para coletar</CardTitle><CardDescription>Informações do cliente existente</CardDescription></CardHeader>
              <CardContent>
                <DataFieldsEditor fields={config.data_fields} customFields={ghl.customFields} onChange={(fields: DataField[]) => updateConfig("data_fields", fields)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Tom de voz</CardTitle></CardHeader>
              <CardContent>
                <ToneSliders creativity={config.tone_creativity} formality={config.tone_formality} naturalness={config.tone_naturalness} aggressiveness={config.tone_aggressiveness} onChange={(field, value) => updateConfig(field, value)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Follow-up automático</CardTitle></CardHeader>
              <CardContent>
                <FollowUpConfigEditor config={config.follow_up_config} onChange={(v: FollowUpConfig) => updateConfig("follow_up_config", v)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Pausa manual da IA</CardTitle>
                <CardDescription>
                  Controle como a IA deve parar de responder quando você assumir a conversa.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-brand-200 bg-brand-50/40">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Label className="text-sm font-semibold text-gray-900">
                        Pausar em qualquer mensagem manual
                      </Label>
                      <Badge variant="default" className="text-[10px]">Recomendado</Badge>
                    </div>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      Quando ativo, a IA pausa automaticamente em qualquer contato no momento em que você (ou outro humano) enviar uma mensagem manual pelo Spark Leads. Sem precisar cadastrar texto fixo. As respostas da própria IA são ignoradas pela detecção.
                    </p>
                  </div>
                  <Switch
                    checked={config.auto_pause_on_human_message ?? false}
                    onCheckedChange={(v) => updateConfig("auto_pause_on_human_message", v)}
                  />
                </div>

              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* PROMPT */}
        <TabsContent value="prompt">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Instruções personalizadas</CardTitle>
                  {config.custom_instructions && (
                    <Button variant="ghost" size="sm" className="text-xs text-red-500 hover:text-red-700 h-7" onClick={() => updateConfig("custom_instructions", "")}>
                      Limpar
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-3">
                  <Label className="text-xs text-gray-500">Modelos prontos (opcional)</Label>
                  <Select onValueChange={(v) => {
                    const template = CONVERSATION_TEMPLATES.find(t => t.id === v);
                    if (template) updateConfig("custom_instructions", template.instructions);
                  }}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione um modelo para começar..." /></SelectTrigger>
                    <SelectContent>
                      {CONVERSATION_TEMPLATES
                        .filter(t => t.agentType === "recruitment_agent" || t.agentType === "both")
                        .map(t => (
                          <SelectItem key={t.id} value={t.id}>
                            <div className="flex flex-col">
                              <span className="text-sm font-medium">{t.label}</span>
                              <span className="text-xs text-gray-400">{t.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <Textarea value={config.custom_instructions} onChange={(e) => updateConfig("custom_instructions", e.target.value)} placeholder={`Exemplos:\n- A oportunidade é para agente financeiro\n- Não mencione valores de comissão\n- Foque em criar curiosidade sobre a oportunidade`} rows={8} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Exemplos de conversa</CardTitle>
                    <CardDescription>Cole exemplos de como a conversa ideal deveria fluir.</CardDescription>
                  </div>
                  {config.conversation_examples && (
                    <Button variant="ghost" size="sm" className="text-xs text-red-500 hover:text-red-700 h-7" onClick={() => updateConfig("conversation_examples", "")}>Limpar</Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <Textarea value={config.conversation_examples || ""} onChange={(e) => updateConfig("conversation_examples", e.target.value)} placeholder={"Exemplo:\nLEAD: oi, vi a vaga\nAGENTE: Que legal! Me conta, você mora onde?\nLEAD: Florida\nAGENTE: Top! E o que você faz hoje?\n..."} rows={6} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Override completo do prompt</CardTitle></CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 mb-3">
                  <Switch checked={config.system_prompt_override !== null} onCheckedChange={(checked) => updateConfig("system_prompt_override", checked ? "" : null)} />
                  <Label>Usar prompt personalizado completo</Label>
                </div>
                {config.system_prompt_override !== null && (
                  <Textarea value={config.system_prompt_override} onChange={(e) => updateConfig("system_prompt_override", e.target.value)} rows={12} placeholder="Prompt completo..." />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* CONTEXTO */}
        <TabsContent value="context">
          <Card>
            <CardHeader><CardTitle>Knowledge Base</CardTitle><CardDescription>Documentos e informações sobre a oportunidade, empresa, etc.</CardDescription></CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label className="text-sm font-medium">Instruções gerais da base de conhecimento</Label>
                <p className="text-xs text-gray-400 mb-2">
                  Descreva os processos e como a IA deve usar TODO o material abaixo. Ex: prioridades, o que nunca dizer, ordem de consulta, tom ao citar informações do material.
                </p>
                <Textarea
                  value={config.knowledge_base_instructions || ""}
                  onChange={(e) => updateConfig("knowledge_base_instructions", e.target.value)}
                  rows={8}
                  placeholder={`Exemplo:\n- Use o PDF "Descrição da vaga" como fonte única de verdade sobre responsabilidades.\n- Nunca cite valores de salário que não estejam no material.\n- Se o lead pedir detalhes técnicos, cite exatamente o que está no documento.`}
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  Este texto é injetado no prompt junto com todos os itens da base. Para instruções de UM item específico, use o botão de editar no item individual abaixo.
                </p>
              </div>
              <div className="border-t border-gray-100 pt-6">
                <KnowledgeBaseEditor agentId={agentId} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TESTE */}
        <TabsContent value="test">
          <AgentTester agentId={agentId} />
        </TabsContent>

        {/* AVANCADO */}
        <TabsContent value="advanced">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Recursos de midia</CardTitle>
                <CardDescription>Habilite capacidades extras de processamento. Cada recurso tem custo adicional por uso.</CardDescription>
              </CardHeader>
              <CardContent>
                <MediaFeaturesEditor
                  enableAudio={config.enable_audio_transcription ?? false}
                  enableImage={config.enable_image_analysis ?? false}
                  enablePdf={config.enable_pdf_reading ?? false}
                  enableSummaryNotes={config.enable_summary_notes ?? false}
                  onChangeAudio={(v) => updateConfig("enable_audio_transcription", v)}
                  onChangeImage={(v) => updateConfig("enable_image_analysis", v)}
                  onChangePdf={(v) => updateConfig("enable_pdf_reading", v)}
                  onChangeSummaryNotes={(v) => updateConfig("enable_summary_notes", v)}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Modelo de IA</CardTitle>
                <CardDescription>Escolha o modelo que melhor se adapta ao seu agente. Claude oferece melhor qualidade conversacional.</CardDescription>
              </CardHeader>
              <CardContent>
                <Select value={config.ai_model} onValueChange={(v) => updateConfig("ai_model", v)}>
                  <SelectTrigger className="w-full max-w-md"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AI_MODELS.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        <div className="flex items-center gap-3 w-full">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${model.provider === "anthropic" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                            {model.provider === "anthropic" ? "Claude" : "GPT"}
                          </span>
                          <span className="text-sm">{model.label}</span>
                          <span className="text-[10px] text-gray-400 ml-auto">{model.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Automações</CardTitle></CardHeader>
              <CardContent>
                <AutomationsEditor rules={config.automations} pipelines={ghl.pipelines} tags={ghl.tags} customFields={ghl.customFields} dataFields={config.data_fields || []} agentId={agentId} onChange={(rules: AutomationRule[]) => updateConfig("automations", rules)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Desligamento da IA</CardTitle></CardHeader>
              <CardContent>
                <DeactivationRulesEditor rules={config.deactivation_rules} tags={ghl.tags} customFields={ghl.customFields} onChange={(rules: DeactivationRule[]) => updateConfig("deactivation_rules", rules)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Timezone</CardTitle></CardHeader>
              <CardContent>
                <TimezoneConfigEditor config={config.timezone_config} locationTimezone={config.working_hours?.timezone || "America/New_York"} onChange={(v: TimezoneConfig) => updateConfig("timezone_config", v)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Configurações de processamento</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Tempo de debounce (segundos)</Label>
                  <Input type="number" min={5} max={60} value={config.debounce_seconds} onChange={(e) => updateConfig("debounce_seconds", Number(e.target.value))} className="mt-1.5 w-32" />
                </div>
                <WorkingHoursEditor config={config.working_hours} onChange={(v: WorkingHoursConfig) => updateConfig("working_hours", v)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Notificações</CardTitle></CardHeader>
              <CardContent>
                <NotificationsConfigEditor config={config.notifications} onChange={(v: NotificationsConfig) => updateConfig("notifications", v)} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </PageWrapper>
  );
}
