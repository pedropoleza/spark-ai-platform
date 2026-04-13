"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Save, Loader2 } from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { useGHLData } from "@/hooks/use-ghl-data";
import { AI_MODELS } from "@/lib/utils/constants";
import { HandoffMessagesEditor } from "@/components/agents/sales/handoff-messages-editor";
import type { AgentConfig, AgentObjective, AgentPersonality, PostBookingConfig, DataField, FollowUpConfig, TargetingRule, WorkingHoursConfig, TimezoneConfig, NotificationsConfig, AutomationRule, DeactivationRule, HandoffMessage, CommunicationChannel } from "@/types/agent";

type ConfigForm = Omit<AgentConfig, "id" | "agent_id" | "created_at" | "updated_at">;

const defaultConfig: ConfigForm = {
  personality: {
    name: "Bruno",
    identity_mode: "human",
    greeting_style: "Oii {name}, tudo bem?",
    farewell_style: "Se em outro momento fizer sentido, pode me chamar por aqui!",
    language: "pt-BR",
    persona_description: "Brasileiro, mora na Florida. Tom casual e amigavel. Conversa como se fosse pelo WhatsApp. Cria conexao humana antes de tudo.",
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
    handoff_message: "Perfeito! Voce vai receber a confirmacao.",
    allow_reschedule: true,
  },
  data_fields: [
    { key: "full_name", label: "Nome completo", required: true, type: "text", skip_if_filled: true },
    { key: "state", label: "Estado", required: true, type: "text", skip_if_filled: true },
    { key: "work_permit", label: "Social Security / Permissao de trabalho", required: true, type: "boolean", skip_if_filled: false },
  ],
  ai_model: "gpt-4.1-mini",
  custom_instructions: "",
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
  // Recruitment-specific
  specialist_name: "",
  specialist_role: "especialista",
  check_legal_docs: false,
  preferred_time_slot: "afternoon_evening",
};

export function RecruitmentConfigContent() {
  const searchParams = useSearchParams();
  const agentId = searchParams.get("id");
  const [config, setConfig] = useState<ConfigForm>(defaultConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ghl = useGHLData();

  const fetchConfig = useCallback(async () => {
    if (!agentId) { setLoading(false); return; }
    try {
      const response = await fetch(`/api/agents/${agentId}/config`);
      if (response.ok) {
        const data = await response.json();
        if (data.config) setConfig({ ...defaultConfig, ...data.config });
      }
    } catch (error) {
      console.error("Erro ao buscar config:", error);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const handleSave = async () => {
    if (!agentId) return;
    setSaving(true); setSaved(false);
    try {
      const res = await fetch(`/api/agents/${agentId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    } catch (error) { console.error("Erro ao salvar config:", error); }
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
      subtitle="Configure como o agente interage com candidatos"
      backHref="/dashboard"
      actions={
        <Button onClick={handleSave} disabled={saving || !agentId}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          {saved ? "Salvo!" : "Salvar"}
        </Button>
      }
    >
      <Tabs defaultValue="targeting" className="animate-fade-in">
        <TabsList>
          <TabsTrigger value="targeting">Segmentacao</TabsTrigger>
          <TabsTrigger value="behavior">Comportamento</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="context">Contexto</TabsTrigger>
          <TabsTrigger value="test">Teste</TabsTrigger>
          <TabsTrigger value="advanced">Avancado</TabsTrigger>
        </TabsList>

        {/* SEGMENTACAO */}
        <TabsContent value="targeting">
          <div className="grid gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Regras de ativacao</CardTitle>
                <CardDescription>Defina quando o agente de recrutamento deve ser ativado</CardDescription>
              </CardHeader>
              <CardContent>
                <TargetingRulesEditor rules={config.targeting_rules} pipelines={ghl.pipelines} tags={ghl.tags} customFields={ghl.customFields} loading={ghl.loading} onChange={(rules: TargetingRule[]) => updateConfig("targeting_rules", rules)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Calendario</CardTitle><CardDescription>Calendario para agendamento de entrevistas</CardDescription></CardHeader>
              <CardContent>
                <Label>Calendario</Label>
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
              <CardHeader><CardTitle>Dados para coletar</CardTitle><CardDescription>Informacoes do candidato</CardDescription></CardHeader>
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
              <CardHeader><CardTitle>Follow-up automatico</CardTitle></CardHeader>
              <CardContent>
                <FollowUpConfigEditor config={config.follow_up_config} onChange={(v: FollowUpConfig) => updateConfig("follow_up_config", v)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Mensagens de encerramento</CardTitle>
                <CardDescription>
                  Cadastre mensagens prontas para encerrar o atendimento da IA e
                  assumir pessoalmente a conversa. Quando voce enviar uma dessas
                  mensagens ao contato, a IA para de responder aquele contato
                  automaticamente.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HandoffMessagesEditor
                  messages={config.handoff_messages || []}
                  onChange={(v: HandoffMessage[]) => updateConfig("handoff_messages", v)}
                />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* PROMPT */}
        <TabsContent value="prompt">
          <div className="grid gap-6">
            <Card>
              <CardHeader><CardTitle>Instrucoes personalizadas</CardTitle></CardHeader>
              <CardContent>
                <Textarea value={config.custom_instructions} onChange={(e) => updateConfig("custom_instructions", e.target.value)} placeholder={`Exemplos:\n- A oportunidade e para agente financeiro\n- Nao mencione valores de comissao\n- Foque em criar curiosidade sobre a oportunidade`} rows={8} />
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
            <CardHeader><CardTitle>Knowledge Base</CardTitle><CardDescription>Documentos e informacoes sobre a oportunidade, empresa, etc.</CardDescription></CardHeader>
            <CardContent><KnowledgeBaseEditor agentId={agentId} /></CardContent>
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
              <CardHeader><CardTitle>Modelo de IA</CardTitle></CardHeader>
              <CardContent>
                <Select value={config.ai_model} onValueChange={(v) => updateConfig("ai_model", v)}>
                  <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>{AI_MODELS.map((model) => (<SelectItem key={model.value} value={model.value}><div className="flex items-center justify-between w-full gap-3"><span>{model.label}</span><span className="text-[10px] text-neutral-400">{model.description}</span></div></SelectItem>))}</SelectContent>
                </Select>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Automacoes</CardTitle></CardHeader>
              <CardContent>
                <AutomationsEditor rules={config.automations} pipelines={ghl.pipelines} tags={ghl.tags} customFields={ghl.customFields} onChange={(rules: AutomationRule[]) => updateConfig("automations", rules)} />
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
              <CardHeader><CardTitle>Configuracoes de processamento</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Tempo de debounce (segundos)</Label>
                  <Input type="number" min={5} max={60} value={config.debounce_seconds} onChange={(e) => updateConfig("debounce_seconds", Number(e.target.value))} className="mt-1.5 w-32" />
                </div>
                <WorkingHoursEditor config={config.working_hours} onChange={(v: WorkingHoursConfig) => updateConfig("working_hours", v)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Notificacoes</CardTitle></CardHeader>
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
