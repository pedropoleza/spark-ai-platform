"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Loader2, Save, Info } from "lucide-react";
import { SparkbotTester } from "@/components/agents/account-assistant/sparkbot-tester";
import { ProactiveRulesPanel } from "@/components/agents/account-assistant/proactive-rules-panel";
import { KnowledgeBaseEditor } from "@/components/agents/sales/knowledge-base-editor";
import { SetupWizard } from "@/components/agents/account-assistant/setup-wizard";

interface SparkbotAgent {
  id: string;
  location_id: string;
  status: string;
  name: string;
}

interface QuietHoursValue {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  days: number[];
}

interface SparkbotConfig {
  // Comportamento
  confirmation_mode: "always" | "medium_and_high" | "high_only";
  no_response_threshold: number;
  ai_model: string;
  fallback_model: string;
  custom_instructions: string;
  knowledge_base_instructions: string;
  // Tom
  tone_creativity: number;
  tone_formality: number;
  tone_naturalness: number;
  tone_aggressiveness: number;
  // Multimodal
  enable_audio_transcription: boolean;
  enable_image_analysis: boolean;
  enable_pdf_reading: boolean;
  // Proatividade
  daily_proactive_limit: number;
  quiet_hours: QuietHoursValue;
  // Segurança / acesso
  disabled_tools: string[];
  enabled_kbs: string[];
}

const DEFAULT_QUIET: QuietHoursValue = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: "America/New_York",
  days: [0, 1, 2, 3, 4, 5, 6],
};

// Lista de tools "high risk" candidatas a desabilitar — admin pode banir
// individualmente se quiser modo restrito. Outras tools (safe/medium)
// raramente são desligadas.
const DESACTIVATABLE_TOOLS = [
  { name: "delete_contact", label: "Apagar contato (delete_contact)" },
  { name: "delete_appointment", label: "Apagar appointment (delete_appointment)" },
  { name: "delete_note", label: "Apagar nota (delete_note)" },
  { name: "delete_task", label: "Apagar task (delete_task)" },
  { name: "delete_opportunity", label: "Apagar opportunity (delete_opportunity)" },
  { name: "send_message_to_contact", label: "Enviar mensagem pro lead (send_message_to_contact)" },
  { name: "create_appointment", label: "Criar appointment (create_appointment)" },
  { name: "import_contacts_from_data", label: "Importar contatos em massa (import_contacts_from_data)" },
];

export function AccountAssistantConfigContent() {
  const [agent, setAgent] = useState<SparkbotAgent | null>(null);
  const [config, setConfig] = useState<SparkbotConfig>({
    confirmation_mode: "high_only",
    no_response_threshold: 3,
    ai_model: "claude-sonnet-4-6",
    fallback_model: "claude-haiku-4-5-20251001",
    custom_instructions: "",
    knowledge_base_instructions: "",
    tone_creativity: 50,
    tone_formality: 50,
    tone_naturalness: 50,
    tone_aggressiveness: 50,
    enable_audio_transcription: true,
    enable_image_analysis: true,
    enable_pdf_reading: true,
    daily_proactive_limit: 10,
    quiet_hours: DEFAULT_QUIET,
    disabled_tools: [],
    enabled_kbs: ["national_life_group", "agency_brazillionaires"],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadAgent = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/sparkbot");
      if (!res.ok) throw new Error("Falha ao carregar SparkBot");
      const data = await res.json();
      if (!data.agent) {
        setLoading(false);
        return;
      }
      setAgent(data.agent);

      const cfgRes = await fetch(`/api/agents/${data.agent.id}/config`);
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        if (cfgData.config) {
          const c = cfgData.config;
          setConfig({
            confirmation_mode: c.confirmation_mode || "high_only",
            no_response_threshold: c.no_response_threshold ?? 3,
            ai_model: c.ai_model || "claude-sonnet-4-6",
            fallback_model: c.fallback_model || "claude-haiku-4-5-20251001",
            custom_instructions: c.custom_instructions || "",
            knowledge_base_instructions: c.knowledge_base_instructions || "",
            tone_creativity: c.tone_creativity ?? 50,
            tone_formality: c.tone_formality ?? 50,
            tone_naturalness: c.tone_naturalness ?? 50,
            tone_aggressiveness: c.tone_aggressiveness ?? 50,
            enable_audio_transcription: c.enable_audio_transcription ?? true,
            enable_image_analysis: c.enable_image_analysis ?? true,
            enable_pdf_reading: c.enable_pdf_reading ?? true,
            daily_proactive_limit: c.daily_proactive_limit ?? 10,
            quiet_hours: (c.quiet_hours && typeof c.quiet_hours === "object" && "enabled" in c.quiet_hours)
              ? c.quiet_hours
              : DEFAULT_QUIET,
            disabled_tools: Array.isArray(c.disabled_tools) ? c.disabled_tools : [],
            enabled_kbs: Array.isArray(c.enabled_kbs) && c.enabled_kbs.length > 0
              ? c.enabled_kbs
              : ["national_life_group", "agency_brazillionaires"],
          });
        }
      }
    } catch (err) {
      console.error("Erro carregando Sparkbot:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  const handleSave = async () => {
    if (!agent) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error("Erro ao salvar", { description: err.error });
        return;
      }
      toast.success("Config salva");
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof SparkbotConfig>(key: K, value: SparkbotConfig[K]) => {
    setConfig((c) => ({ ...c, [key]: value }));
  };

  const toggleDisabledTool = (toolName: string, disabled: boolean) => {
    setConfig((c) => ({
      ...c,
      disabled_tools: disabled
        ? Array.from(new Set([...c.disabled_tools, toolName]))
        : c.disabled_tools.filter((t) => t !== toolName),
    }));
  };

  const toggleEnabledKb = (kb: string, enabled: boolean) => {
    setConfig((c) => ({
      ...c,
      enabled_kbs: enabled
        ? Array.from(new Set([...c.enabled_kbs, kb]))
        : c.enabled_kbs.filter((k) => k !== kb),
    }));
  };

  if (loading) {
    return (
      <PageWrapper title="SparkBot" subtitle="Account Assistant">
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        </div>
      </PageWrapper>
    );
  }

  if (!agent) {
    return (
      <PageWrapper title="SparkBot" subtitle="Account Assistant">
        <Card>
          <CardContent className="p-8 text-center">
            <Info className="w-10 h-10 mx-auto text-gray-400 mb-3" />
            <p className="text-sm text-gray-700 font-medium mb-1">SparkBot não configurado</p>
            <p className="text-xs text-gray-500 max-w-md mx-auto">
              O admin ainda não criou o agent tipo <code>account_assistant</code> na location
              Hub. Peça pro Pedro (admin da plataforma) provisionar.
            </p>
          </CardContent>
        </Card>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper title="SparkBot" subtitle="Copiloto de produtividade pro agente">
      {/* Setup Wizard em destaque — só renderiza se admin nunca interagiu
          com o bot. Auto-some quando primeira msg detectada. */}
      <div className="mb-4">
        <SetupWizard />
      </div>
      <Tabs defaultValue="test" className="space-y-4">
        <TabsList>
          <TabsTrigger value="test">Teste</TabsTrigger>
          <TabsTrigger value="proactivity">Proatividade</TabsTrigger>
          <TabsTrigger value="config">Configurações</TabsTrigger>
          <TabsTrigger value="kb">Base de Conhecimento</TabsTrigger>
          <TabsTrigger value="about">Sobre</TabsTrigger>
        </TabsList>

        <TabsContent value="test" className="space-y-3">
          <SparkbotTester agentId={agent.id} />
        </TabsContent>

        <TabsContent value="proactivity" className="space-y-3">
          <ProactivityTab agentId={agent.id} />
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          {/* Comportamento geral */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Comportamento</CardTitle>
              <CardDescription>
                Como o bot decide entre executar direto ou pedir confirmação,
                instruções customizadas e modelo de IA.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-2xl">
              <div>
                <Label className="text-sm font-medium">Modo de confirmação</Label>
                <p className="text-xs text-gray-500 mb-2">
                  Quando o bot deve pedir &ldquo;Confirma?&rdquo; antes de executar.
                </p>
                <select
                  value={config.confirmation_mode}
                  onChange={(e) => updateField("confirmation_mode", e.target.value as SparkbotConfig["confirmation_mode"])}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white max-w-md"
                >
                  <option value="always">Sempre (até leitura)</option>
                  <option value="medium_and_high">Ações que mudam dados</option>
                  <option value="high_only">Só ações irreversíveis (recomendado)</option>
                </select>
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="custom_instructions">
                  Instruções customizadas
                </Label>
                <p className="text-xs text-gray-500 mb-2">
                  Texto livre que o bot vai seguir COM PRIORIDADE. Use pra orientações
                  específicas da agência (ex: &ldquo;sempre que rep pedir cotação, lembre
                  de checar elegibilidade FN antes&rdquo;).
                </p>
                <Textarea
                  id="custom_instructions"
                  value={config.custom_instructions}
                  onChange={(e) => updateField("custom_instructions", e.target.value)}
                  rows={5}
                  className="text-sm"
                  placeholder="Ex: Sempre que rep pedir &quot;novo lead&quot;, perguntar primeiro se tem o phone E o email antes de criar."
                  maxLength={3000}
                />
                <p className="text-[10px] text-gray-400 mt-1">{config.custom_instructions.length}/3000 chars</p>
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="model">Modelo IA primário</Label>
                <p className="text-xs text-gray-500 mb-2">
                  Claude Sonnet 4.6 é o default (melhor em tool use complexo).
                </p>
                <select
                  id="model"
                  value={config.ai_model}
                  onChange={(e) => updateField("ai_model", e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white max-w-md"
                >
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (recomendado)</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                  <option value="gpt-4.1">GPT-4.1</option>
                  <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                </select>
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="fallback_model">Modelo de fallback</Label>
                <p className="text-xs text-gray-500 mb-2">
                  Se o primário falhar (rate-limit, 5xx), tenta este. Default Haiku 4.5
                  (mesmo provider, capacity pool diferente).
                </p>
                <select
                  id="fallback_model"
                  value={config.fallback_model}
                  onChange={(e) => updateField("fallback_model", e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white max-w-md"
                >
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (default)</option>
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                  <option value="gpt-4.1">GPT-4.1</option>
                  <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Tom (sliders) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tom da personalidade</CardTitle>
              <CardDescription>
                Sliders 0-100. Valores médios (~40-60) = neutro. Extremos
                ajustam o estilo de fala do bot. Por enquanto só extremos
                (≤30 ou ≥70) afetam — valores intermediários são neutros.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-2xl">
              {([
                ["tone_creativity", "Criatividade", "Factual / direto", "Criativo / com analogias"],
                ["tone_formality", "Formalidade", "Coloquial (vc, gírias)", "Formal (você, sem gírias)"],
                ["tone_naturalness", "Naturalidade", "Estruturado", "Natural (tipo, né, então)"],
                ["tone_aggressiveness", "Assertividade", "Gentil / paciente", "Direto ao ponto"],
              ] as const).map(([key, label, low, high]) => (
                <div key={key}>
                  <Label className="text-sm font-medium">{label}</Label>
                  <p className="text-xs text-gray-500 mb-2">
                    {low} ↔ {high}
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={config[key]}
                      onChange={(e) => updateField(key, Number(e.target.value))}
                      className="flex-1"
                    />
                    <span className="text-xs text-gray-600 w-10 text-right">{config[key]}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Multimodal */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Multimodal</CardTitle>
              <CardDescription>
                Tipos de mensagem que o bot processa. Desabilitar = bot pede
                pro rep mandar em texto.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 max-w-2xl">
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <div>
                  <Label className="text-sm font-medium">Áudio (Whisper)</Label>
                  <p className="text-xs text-gray-500">Transcreve voice notes do WhatsApp.</p>
                </div>
                <Switch
                  checked={config.enable_audio_transcription}
                  onCheckedChange={(v) => updateField("enable_audio_transcription", v)}
                />
              </div>
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <div>
                  <Label className="text-sm font-medium">Imagens (Claude Vision)</Label>
                  <p className="text-xs text-gray-500">Analisa fotos e screenshots.</p>
                </div>
                <Switch
                  checked={config.enable_image_analysis}
                  onCheckedChange={(v) => updateField("enable_image_analysis", v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">PDFs e planilhas</Label>
                  <p className="text-xs text-gray-500">Extrai texto + processa CSV/XLSX.</p>
                </div>
                <Switch
                  checked={config.enable_pdf_reading}
                  onCheckedChange={(v) => updateField("enable_pdf_reading", v)}
                />
              </div>
            </CardContent>
          </Card>

          {/* Proatividade */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Proatividade</CardTitle>
              <CardDescription>
                Quando e quanto o bot pode tomar iniciativa de mandar msg pro rep.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-2xl">
              <div>
                <Label className="text-sm font-medium" htmlFor="daily_limit">Limite diário de proativos</Label>
                <p className="text-xs text-gray-500 mb-2">
                  Anti-spam: bot envia no máximo N msgs proativas pro mesmo rep
                  em 24h. Reminders pedidos pelo rep não contam. 0 = sem limite.
                </p>
                <Input
                  id="daily_limit"
                  type="number"
                  min={0}
                  max={100}
                  value={config.daily_proactive_limit}
                  onChange={(e) => updateField("daily_proactive_limit", parseInt(e.target.value) || 0)}
                  className="max-w-[120px]"
                />
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="nort">
                  Pausar após quantas msgs sem resposta
                </Label>
                <p className="text-xs text-gray-500 mb-2">
                  Se o rep ignorar N proativos seguidos, bot pausa por 24h.
                </p>
                <Input
                  id="nort"
                  type="number"
                  min={1}
                  max={20}
                  value={config.no_response_threshold}
                  onChange={(e) => updateField("no_response_threshold", parseInt(e.target.value) || 3)}
                  className="max-w-[120px]"
                />
              </div>

              <div className="border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <Label className="text-sm font-medium">Quiet hours</Label>
                    <p className="text-xs text-gray-500">
                      Janela onde bot NUNCA envia proativo (lembretes pedidos pelo rep
                      ainda chegam no horário).
                    </p>
                  </div>
                  <Switch
                    checked={config.quiet_hours.enabled}
                    onCheckedChange={(v) =>
                      updateField("quiet_hours", { ...config.quiet_hours, enabled: v })
                    }
                  />
                </div>
                {config.quiet_hours.enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Início</Label>
                      <Input
                        type="time"
                        value={config.quiet_hours.start}
                        onChange={(e) =>
                          updateField("quiet_hours", { ...config.quiet_hours, start: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Fim</Label>
                      <Input
                        type="time"
                        value={config.quiet_hours.end}
                        onChange={(e) =>
                          updateField("quiet_hours", { ...config.quiet_hours, end: e.target.value })
                        }
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Timezone</Label>
                      <Input
                        type="text"
                        placeholder="America/New_York"
                        value={config.quiet_hours.timezone}
                        onChange={(e) =>
                          updateField("quiet_hours", { ...config.quiet_hours, timezone: e.target.value })
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Knowledge Bases (carrier) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Knowledge bases da Carrier (Tool query_carrier_knowledge)</CardTitle>
              <CardDescription>
                Quais KBs com embeddings o bot pode consultar via tool.
                Diferente da &ldquo;Base de conhecimento&rdquo; (próxima aba) que é texto livre.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 max-w-2xl">
              {([
                ["national_life_group", "National Life Group (NLG)", "Regras técnicas de produto, UW, riders, FN, compliance"],
                ["agency_brazillionaires", "Brazillionaires (sub-agência)", "Treinamento, scripts, dicas operacionais, processos"],
              ] as const).map(([key, name, desc]) => (
                <div key={key} className="flex items-center justify-between border-b border-gray-100 pb-3 last:border-b-0 last:pb-0">
                  <div>
                    <Label className="text-sm font-medium">{name}</Label>
                    <p className="text-xs text-gray-500">{desc}</p>
                  </div>
                  <Switch
                    checked={config.enabled_kbs.includes(key)}
                    onCheckedChange={(v) => toggleEnabledKb(key, v)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Tools desabilitadas */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tools desabilitadas</CardTitle>
              <CardDescription>
                Tools high-risk que você pode banir desta location. Bot nem
                vê o schema delas — não consegue tentar usar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 max-w-2xl">
              {DESACTIVATABLE_TOOLS.map((t) => {
                const isDisabled = config.disabled_tools.includes(t.name);
                return (
                  <div key={t.name} className="flex items-center justify-between text-sm">
                    <span>{t.label}</span>
                    <Switch
                      checked={isDisabled}
                      onCheckedChange={(v) => toggleDisabledTool(t.name, v)}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="pt-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Salvar configurações
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="kb" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Base de Conhecimento custom</CardTitle>
              <CardDescription>
                Documentos, URLs ou textos que o admin sobe pra contextualizar o bot.
                O conteúdo vai injetado no prompt direto (sem embeddings) — diferente
                das KBs da Carrier (NLG/Brazillionaires) que usam tool com search.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-sm font-medium" htmlFor="kb_instructions">
                  Instruções gerais da base
                </Label>
                <p className="text-xs text-gray-500 mb-2">
                  Texto que aparece antes dos itens. Use pra dizer ao bot como usar
                  (&ldquo;cite a fonte&rdquo;, &ldquo;não invente&rdquo;, etc).
                </p>
                <Textarea
                  id="kb_instructions"
                  value={config.knowledge_base_instructions}
                  onChange={(e) => updateField("knowledge_base_instructions", e.target.value)}
                  rows={3}
                  className="text-sm"
                  placeholder="Ex: Use estes documentos como fonte oficial. Cite o título do item quando referenciar."
                  maxLength={4000}
                />
                <div className="flex items-center justify-between mt-2">
                  <p className="text-[10px] text-gray-400">{config.knowledge_base_instructions.length}/4000 chars</p>
                  <Button size="sm" onClick={handleSave} disabled={saving} variant="outline">
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Salvar instruções"}
                  </Button>
                </div>
              </div>
              <div className="border-t border-gray-100 pt-4">
                <KnowledgeBaseEditor agentId={agent.id} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="about" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sobre o SparkBot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-gray-700">
              <p>
                O SparkBot é um copiloto de produtividade pro agente humano —
                diferente do Agente de Vendas e do Agente de Recrutamento, que conversam
                com leads.
              </p>
              <div>
                <p className="font-medium mb-1">Capacidades</p>
                <ul className="list-disc pl-5 text-xs text-gray-600 space-y-0.5">
                  <li>~40 tools — leitura, escrita, calendário, opportunities, mensagens, KB</li>
                  <li>Multimodal: WhatsApp text/audio/imagem/PDF/CSV/XLSX (Whisper + Claude Vision)</li>
                  <li>Proatividade: 14 regras (briefings, alertas, resumos diários/semanais)</li>
                  <li>Schedule reminder: rep pede &ldquo;me lembra em X&rdquo; e bot agenda</li>
                  <li>Carrier KB: NLG + Brazillionaires com embeddings (Voyage 1024)</li>
                  <li>Confirmação configurável: always / medium / high (default high_only)</li>
                </ul>
              </div>
              <div>
                <p className="font-medium mb-1">Como o rep usa em prod</p>
                <p className="text-xs text-gray-600">
                  Agente manda WhatsApp pro número dedicado do SparkBot (Stevo/Evolution
                  rotea WhatsApp Web / SMS). Primeira msg recebe termos de uso. Depois
                  pode pedir ações em texto/áudio/foto/doc. Ações executam no Spark Leads
                  da location ativa do rep.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageWrapper>
  );
}

/**
 * Tab Proatividade — lê o sessionId do localStorage (mesmo key do tester)
 * pra integrar a simulação com a sessão de teste já aberta.
 */
function ProactivityTab({ agentId }: { agentId: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [repPhone, setRepPhone] = useState<string>("");

  useEffect(() => {
    const key = `sparkbot-test-session:${agentId}`;
    const update = () => {
      const v = localStorage.getItem(key);
      setSessionId(v);
    };
    update();
    const interval = setInterval(update, 1500);
    window.addEventListener("storage", update);
    return () => {
      clearInterval(interval);
      window.removeEventListener("storage", update);
    };
  }, [agentId]);

  return (
    <div className="space-y-3">
      <ProactiveRulesPanel testSessionId={sessionId} repPhone={repPhone} />
      <Card>
        <CardContent className="p-3">
          <Label className="text-xs">Phone do rep (override pra simulação)</Label>
          <Input
            value={repPhone}
            onChange={(e) => setRepPhone(e.target.value)}
            placeholder="+5511987654321"
            className="text-xs mt-1"
          />
          <p className="text-[10px] text-gray-400 mt-1">
            Se teu user GHL não tiver phone cadastrado, use isso pra a simulação saber qual rep você é.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
