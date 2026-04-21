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
import { AI_MODELS } from "@/lib/utils/constants";
import type { AgentConfig, AgentObjective, AgentPersonality, PostBookingConfig, DataField, FollowUpConfig, TargetingRule, WorkingHoursConfig, TimezoneConfig, NotificationsConfig, AutomationRule, DeactivationRule, CommunicationChannel } from "@/types/agent";

type ConfigForm = Omit<AgentConfig, "id" | "agent_id" | "created_at" | "updated_at">;

const defaultConfig: ConfigForm = {
  personality: {
    name: "Assistente",
    identity_mode: "assistant",
    greeting_style: "Oi {name}!",
    farewell_style: "Qualquer duvida, estou por aqui!",
    language: "pt-BR",
    persona_description: "",
  },
  targeting_rules: [],
  enabled_channels: ["SMS", "WhatsApp"],
  calendar_id: null,
  tone_creativity: 50,
  tone_formality: 30,
  tone_naturalness: 50,
  tone_aggressiveness: 50,
  objective: "qualification_and_booking",
  post_booking: {
    behavior: "stop_and_handoff",
    handoff_message: "Obrigado! Um membro da nossa equipe entrara em contato em breve.",
    allow_reschedule: true,
  },
  data_fields: [
    { key: "full_name", label: "Nome completo", required: true, type: "text", sync_to_ghl: false },
    { key: "date_of_birth", label: "Data de nascimento", required: true, type: "date", sync_to_ghl: false },
    { key: "state", label: "Estado onde mora", required: true, type: "text", sync_to_ghl: false },
    { key: "smoker_status", label: "Fumante", required: true, type: "boolean", sync_to_ghl: false },
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
      monday: { enabled: true, start: "09:00", end: "17:00" },
      tuesday: { enabled: true, start: "09:00", end: "17:00" },
      wednesday: { enabled: true, start: "09:00", end: "17:00" },
      thursday: { enabled: true, start: "09:00", end: "17:00" },
      friday: { enabled: true, start: "09:00", end: "17:00" },
      saturday: { enabled: false, start: "09:00", end: "13:00" },
      sunday: { enabled: false, start: "09:00", end: "13:00" },
    },
  },
  follow_up_config: {
    enabled: false,
    mode: "ai_auto",
    intensity: 5,
    max_attempts: 5,
    min_delay_minutes: 10,
    max_delay_minutes: 10080,
    custom_prompt: "",
    manual_steps: [],
  },
  timezone_config: {
    use_location_default: true,
    custom_timezone: "",
    confirm_before_booking: true,
    auto_detect_from_state: true,
  },
  notifications: {
    on_qualified: false,
    on_booked: false,
    on_handed_off: false,
    on_error: false,
    notification_email: "",
  },
  automations: [],
  deactivation_rules: [],
  handoff_messages: [],
  auto_pause_on_human_message: true,
  enable_audio_transcription: false,
  enable_image_analysis: false,
  enable_pdf_reading: false,
};

export function SalesConfigContent() {
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
    if (!agentId) {
      setLoading(false);
      return;
    }

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

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Warn before leaving with unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const handleSave = async () => {
    if (!agentId) return;
    setSaving(true);
    setSaved(false);

    try {
      const response = await fetch(`/api/agents/${agentId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (response.ok) {
        setSaved(true);
        setSavedConfig(config);
        toast.success("Configurações salvas com sucesso!", {
          description: "Todas as regras foram atualizadas.",
          duration: 4000,
        });
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await response.json().catch(() => ({}));
        toast.error("Erro ao salvar configurações", {
          description: data.error || `Erro ${response.status}`,
          duration: 6000,
        });
      }
    } catch (error) {
      console.error("Erro ao salvar config:", error);
      toast.error("Erro de conexão", {
        description: "Não foi possível salvar. Verifique sua conexão.",
        duration: 6000,
      });
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <PageWrapper title="Agente de Vendas" backHref="/dashboard">
        <div className="space-y-4">
          <Skeleton className="h-10 w-96" />
          <Skeleton className="h-64" />
        </div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper
      title="Agente de Vendas"
      subtitle="Configure como o agente interage com seus leads"
      backHref="/dashboard"
      actions={
        <Button onClick={handleSave} disabled={saving || !agentId} variant={saved ? "outline" : "default"} className={saved ? "border-green-500 text-green-600" : ""}>
          {saving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4 mr-2" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
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

        {/* ==================== SEGMENTACAO ==================== */}
        <TabsContent value="targeting">
          <div className="grid gap-6">
            {/* Regras de ativação */}
            <Card>
              <CardHeader>
                <CardTitle>Regras de ativação</CardTitle>
                <CardDescription>
                  Defina quando o agente deve ser ativado para um lead.
                  Você pode combinar múltiplas regras — o agente ativa quando qualquer uma delas for atendida.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TargetingRulesEditor
                  rules={config.targeting_rules}
                  pipelines={ghl.pipelines}
                  tags={ghl.tags}
                  customFields={ghl.customFields}
                  loading={ghl.loading}
                  onChange={(rules: TargetingRule[]) => updateConfig("targeting_rules", rules)}
                />
              </CardContent>
            </Card>

            {/* Calendário */}
            <Card>
              <CardHeader>
                <CardTitle>Calendário</CardTitle>
                <CardDescription>
                  Calendário para agendamento de reuniões
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Label>Calendário</Label>
                {ghl.loading ? (
                  <Skeleton className="h-10 mt-1.5" />
                ) : (
                  <Select
                    value={config.calendar_id || ""}
                    onValueChange={(v) => updateConfig("calendar_id", v || null)}
                  >
                    <SelectTrigger className="mt-1.5">
                      <SelectValue placeholder="Selecione um calendário..." />
                    </SelectTrigger>
                    <SelectContent>
                      {ghl.calendars.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </CardContent>
            </Card>

            {/* Canais */}
            <Card>
              <CardHeader>
                <CardTitle>Canais</CardTitle>
                <CardDescription>
                  Selecione por quais canais o agente pode se comunicar.
                  O agente sempre responde pelo mesmo canal que o lead usou.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChannelSelector
                  selected={config.enabled_channels}
                  onChange={(channels: CommunicationChannel[]) => updateConfig("enabled_channels", channels)}
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ==================== COMPORTAMENTO ==================== */}
        <TabsContent value="behavior">
          <div className="grid gap-6">
            {/* Personalidade */}
            <Card>
              <CardHeader>
                <CardTitle>Personalidade</CardTitle>
                <CardDescription>
                  Defina o nome, identidade e comportamento da IA
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PersonalityEditor
                  personality={config.personality}
                  onChange={(v: AgentPersonality) => updateConfig("personality", v)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Objetivo do agente</CardTitle>
                <CardDescription>
                  Defina o que o agente deve fazer com cada lead
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ObjectiveSelector
                  value={config.objective}
                  onChange={(v) => updateConfig("objective", v as AgentObjective)}
                />
              </CardContent>
            </Card>

            {/* Pos-agendamento */}
            {config.objective !== "qualification_only" && (
              <Card>
                <CardHeader>
                  <CardTitle>Apos o agendamento</CardTitle>
                  <CardDescription>
                    Defina o que acontece depois que o lead agenda uma reunião
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PostBookingConfigEditor
                    config={config.post_booking}
                    onChange={(v: PostBookingConfig) => updateConfig("post_booking", v)}
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Dados para coletar</CardTitle>
                <CardDescription>
                  Configure quais informações o agente deve coletar. Campos vinculados
                  a Custom Fields sao atualizados automaticamente no Spark.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DataFieldsEditor
                  fields={config.data_fields}
                  customFields={ghl.customFields}
                  onChange={(fields: DataField[]) => updateConfig("data_fields", fields)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Tom de voz</CardTitle>
                <CardDescription>
                  Ajuste como o agente se comunica com os leads
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ToneSliders
                  creativity={config.tone_creativity}
                  formality={config.tone_formality}
                  naturalness={config.tone_naturalness}
                  aggressiveness={config.tone_aggressiveness}
                  onChange={(field, value) => updateConfig(field, value)}
                />
              </CardContent>
            </Card>

            {/* Follow-up */}
            <Card>
              <CardHeader>
                <CardTitle>Follow-up automático</CardTitle>
                <CardDescription>
                  Configure como o agente reentra em contato quando o lead para de responder
                </CardDescription>
              </CardHeader>
              <CardContent>
                <FollowUpConfigEditor
                  config={config.follow_up_config}
                  onChange={(v: FollowUpConfig) => updateConfig("follow_up_config", v)}
                />
              </CardContent>
            </Card>

            {/* Pausa manual da IA */}
            <Card>
              <CardHeader>
                <CardTitle>Pausa manual da IA</CardTitle>
                <CardDescription>
                  Controle como a IA deve parar de responder quando você assumir a conversa.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Toggle principal: pausar em qualquer mensagem manual */}
                <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-brand-200 bg-brand-50/40">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Label className="text-sm font-semibold text-gray-900">
                        Pausar em qualquer mensagem manual
                      </Label>
                      <Badge variant="default" className="text-[10px]">Recomendado</Badge>
                    </div>
                    <p className="text-xs text-gray-600 leading-relaxed">
                      Quando ativo, a IA pausa automaticamente em qualquer contato no momento em que você (ou outro humano) enviar uma mensagem manual pelo GHL. Sem precisar cadastrar texto fixo. As respostas da própria IA são ignoradas pela detecção.
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

        {/* ==================== PROMPT ==================== */}
        <TabsContent value="prompt">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Instruções personalizadas</CardTitle>
                <CardDescription>
                  Adicione instruções específicas para o agente. Estas instruções
                  são adicionadas ao prompt do sistema.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={config.custom_instructions}
                  onChange={(e) => updateConfig("custom_instructions", e.target.value)}
                  placeholder={`Exemplos:\n- Sempre mencione que somos especializados em seguro de vida\n- Não fale sobre preços, diga que será discutido na reunião\n- Se o lead perguntar sobre cobertura, explique de forma geral`}
                  rows={8}
                />
                <p className="text-xs text-gray-500 mt-2">
                  Dica: Seja claro e especifico sobre o que o agente deve ou nao deve fazer
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Override completo do prompt (avançado)</CardTitle>
                <CardDescription>
                  Substitua completamente o prompt gerado automaticamente. Use com cautela.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3 mb-3">
                  <Switch
                    checked={config.system_prompt_override !== null}
                    onCheckedChange={(checked) =>
                      updateConfig("system_prompt_override", checked ? "" : null)
                    }
                  />
                  <Label>Usar prompt personalizado completo</Label>
                </div>
                {config.system_prompt_override !== null && (
                  <Textarea
                    value={config.system_prompt_override}
                    onChange={(e) => updateConfig("system_prompt_override", e.target.value)}
                    placeholder="Cole aqui o prompt completo do sistema..."
                    rows={12}
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ==================== CONTEXTO ==================== */}
        <TabsContent value="context">
          <Card>
            <CardHeader>
              <CardTitle>Knowledge Base</CardTitle>
              <CardDescription>
                Adicione documentos, textos ou URLs para que a IA use como referencia nas conversas.
                O conteudo sera incluido no contexto do prompt automaticamente.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label className="text-sm font-medium">Instruções gerais da base de conhecimento</Label>
                <p className="text-xs text-gray-400 mb-2">
                  Descreva os processos e como a IA deve usar TODO o material abaixo. Ex: prioridades, o que nunca dizer, ordem de consulta, termos proibidos, tom ao citar informações do material.
                </p>
                <Textarea
                  value={config.knowledge_base_instructions || ""}
                  onChange={(e) => updateConfig("knowledge_base_instructions", e.target.value)}
                  rows={8}
                  placeholder={`Exemplo:\n- Sempre que o lead perguntar sobre preços, consulte primeiro o PDF "Tabela 2026" e cite o valor exato.\n- Processo de venda: qualificar necessidade -> apresentar planos do documento oficial -> agendar reunião.\n- NUNCA ofereça desconto. Não está previsto em nenhum material.\n- Se o lead pedir algo técnico não coberto, diga que vai confirmar com a equipe.\n- Ao citar números (prazos, valores, SKUs), use exatamente o que está no material.`}
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  Este texto é injetado no prompt junto com todos os itens da base. Para instruções específicas de UM item (um PDF em particular), use o botão de editar no item individual abaixo.
                </p>
              </div>
              <div className="border-t border-gray-100 pt-6">
                <KnowledgeBaseEditor agentId={agentId} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ==================== TESTE ==================== */}
        <TabsContent value="test">
          <AgentTester agentId={agentId} />
        </TabsContent>

        {/* ==================== AVANCADO ==================== */}
        <TabsContent value="advanced">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Recursos de midia</CardTitle>
                <CardDescription>
                  Habilite capacidades extras de processamento. Cada recurso tem custo adicional por uso.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MediaFeaturesEditor
                  enableAudio={config.enable_audio_transcription ?? false}
                  enableImage={config.enable_image_analysis ?? false}
                  enablePdf={config.enable_pdf_reading ?? false}
                  onChangeAudio={(v) => updateConfig("enable_audio_transcription", v)}
                  onChangeImage={(v) => updateConfig("enable_image_analysis", v)}
                  onChangePdf={(v) => updateConfig("enable_pdf_reading", v)}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Modelo de IA</CardTitle>
                <CardDescription>
                  Escolha o modelo que melhor se adapta ao seu agente. Claude oferece melhor qualidade conversacional.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={config.ai_model}
                  onValueChange={(v) => updateConfig("ai_model", v)}
                >
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue />
                  </SelectTrigger>
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

            {/* Automacoes */}
            <Card>
              <CardHeader>
                <CardTitle>Automações</CardTitle>
                <CardDescription>
                  Configure ações automáticas que são executadas quando um evento acontece
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AutomationsEditor
                  rules={config.automations}
                  pipelines={ghl.pipelines}
                  tags={ghl.tags}
                  customFields={ghl.customFields}
                  dataFields={config.data_fields || []}
                  agentId={agentId}
                  onChange={(rules: AutomationRule[]) => updateConfig("automations", rules)}
                />
              </CardContent>
            </Card>

            {/* Desligamento */}
            <Card>
              <CardHeader>
                <CardTitle>Desligamento da IA</CardTitle>
                <CardDescription>
                  Defina condições que desligam a IA para um contato. A IA também para
                  automaticamente se o contato perder o critério de ativação.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DeactivationRulesEditor
                  rules={config.deactivation_rules}
                  tags={ghl.tags}
                  customFields={ghl.customFields}
                  onChange={(rules: DeactivationRule[]) => updateConfig("deactivation_rules", rules)}
                />
              </CardContent>
            </Card>

            {/* Timezone */}
            <Card>
              <CardHeader>
                <CardTitle>Timezone</CardTitle>
                <CardDescription>
                  Configure o fuso horário para agendamentos
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TimezoneConfigEditor
                  config={config.timezone_config}
                  locationTimezone={config.working_hours?.timezone || "America/New_York"}
                  onChange={(v: TimezoneConfig) => updateConfig("timezone_config", v)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Configurações de processamento</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Tempo de debounce (segundos)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={60}
                    value={config.debounce_seconds}
                    onChange={(e) => updateConfig("debounce_seconds", Number(e.target.value))}
                    className="mt-1.5 w-32"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Tempo de espera para agrupar mensagens rapidas antes de processar
                  </p>
                </div>

                <div>
                  <Label>Máximo de mensagens por conversa</Label>
                  <Input
                    type="number"
                    min={10}
                    max={200}
                    value={config.max_messages_per_conversation}
                    onChange={(e) =>
                      updateConfig("max_messages_per_conversation", Number(e.target.value))
                    }
                    className="mt-1.5 w-32"
                  />
                </div>

                <WorkingHoursEditor
                  config={config.working_hours}
                  onChange={(v: WorkingHoursConfig) => updateConfig("working_hours", v)}
                />
              </CardContent>
            </Card>

            {/* Notificacoes */}
            <Card>
              <CardHeader>
                <CardTitle>Notificações</CardTitle>
                <CardDescription>
                  Receba alertas quando eventos importantes acontecerem
                </CardDescription>
              </CardHeader>
              <CardContent>
                <NotificationsConfigEditor
                  config={config.notifications}
                  onChange={(v: NotificationsConfig) => updateConfig("notifications", v)}
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </PageWrapper>
  );
}
