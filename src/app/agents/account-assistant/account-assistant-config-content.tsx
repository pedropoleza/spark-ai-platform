"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Save, Info } from "lucide-react";
import { SparkbotTester } from "@/components/agents/account-assistant/sparkbot-tester";

interface SparkbotAgent {
  id: string;
  location_id: string;
  status: string;
  name: string;
}

interface SparkbotConfig {
  confirmation_mode: "always" | "medium_and_high" | "high_only";
  no_response_threshold: number;
  ai_model: string;
}

export function AccountAssistantConfigContent() {
  const [agent, setAgent] = useState<SparkbotAgent | null>(null);
  const [config, setConfig] = useState<SparkbotConfig>({
    confirmation_mode: "medium_and_high",
    no_response_threshold: 3,
    ai_model: "claude-sonnet-4-6",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadAgent = useCallback(async () => {
    try {
      // Sparkbot é único globalmente (não por location) — endpoint dedicado.
      const res = await fetch("/api/agents/sparkbot");
      if (!res.ok) throw new Error("Falha ao carregar Sparkbot");
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
          setConfig({
            confirmation_mode: cfgData.config.confirmation_mode || "medium_and_high",
            no_response_threshold: cfgData.config.no_response_threshold || 3,
            ai_model: cfgData.config.ai_model || "claude-sonnet-4-6",
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

  if (loading) {
    return (
      <PageWrapper title="Sparkbot" subtitle="Account Assistant (V1)">
        <div className="flex justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        </div>
      </PageWrapper>
    );
  }

  if (!agent) {
    return (
      <PageWrapper title="Sparkbot" subtitle="Account Assistant (V1)">
        <Card>
          <CardContent className="p-8 text-center">
            <Info className="w-10 h-10 mx-auto text-gray-400 mb-3" />
            <p className="text-sm text-gray-700 font-medium mb-1">Sparkbot não configurado</p>
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
    <PageWrapper title="Sparkbot" subtitle="Copiloto de produtividade pro rep comercial — V1">
      <Tabs defaultValue="test" className="space-y-4">
        <TabsList>
          <TabsTrigger value="test">Teste</TabsTrigger>
          <TabsTrigger value="rules">Regras</TabsTrigger>
          <TabsTrigger value="about">Sobre</TabsTrigger>
        </TabsList>

        <TabsContent value="test" className="space-y-3">
          <SparkbotTester />
        </TabsContent>

        <TabsContent value="rules" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Regras de confirmação e alertas</CardTitle>
              <CardDescription>
                Define quando o Sparkbot pede confirmação antes de agir e quando ele pausa
                por falta de resposta do rep.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-w-lg">
              <div>
                <Label className="text-sm font-medium">Modo de confirmação</Label>
                <p className="text-xs text-gray-500 mb-2">
                  Quando o bot deve pedir &ldquo;tem certeza?&rdquo; antes de executar.
                </p>
                <select
                  value={config.confirmation_mode}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      confirmation_mode: e.target.value as SparkbotConfig["confirmation_mode"],
                    })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="always">Sempre (até leitura)</option>
                  <option value="medium_and_high">Ações que mudam dados (recomendado)</option>
                  <option value="high_only">Só ações irreversíveis</option>
                </select>
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="nort">
                  Pausar após quantas msgs sem resposta
                </Label>
                <p className="text-xs text-gray-500 mb-2">
                  Se o rep ignorar N msgs seguidas do bot, ele pausa por 24h.
                </p>
                <Input
                  id="nort"
                  type="number"
                  min={1}
                  max={20}
                  value={config.no_response_threshold}
                  onChange={(e) =>
                    setConfig({ ...config, no_response_threshold: parseInt(e.target.value) || 3 })
                  }
                  className="max-w-[120px]"
                />
              </div>

              <div>
                <Label className="text-sm font-medium" htmlFor="model">
                  Modelo IA
                </Label>
                <p className="text-xs text-gray-500 mb-2">
                  Claude Sonnet 4.6 é o default (melhor em tool use). Mudança afeta custo e qualidade.
                </p>
                <select
                  id="model"
                  value={config.ai_model}
                  onChange={(e) => setConfig({ ...config, ai_model: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white max-w-sm"
                >
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (recomendado) — $3/$15</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 — $0.80/$4</option>
                  <option value="gpt-4.1">GPT-4.1 — $2/$8</option>
                  <option value="gpt-4.1-mini">GPT-4.1 Mini — $0.40/$1.60</option>
                </select>
              </div>

              <div className="pt-3 border-t border-gray-100">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Salvar
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="about" className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sobre o Sparkbot V1</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-gray-700">
              <p>
                O Sparkbot é um copiloto de produtividade pro rep comercial humano — diferente
                do Agente de Vendas e Agente de Recrutamento, que conversam com leads.
              </p>
              <div>
                <p className="font-medium mb-1">Capacidades V1 (8 tools)</p>
                <ul className="list-disc pl-5 text-xs text-gray-600 space-y-0.5">
                  <li>Leitura: search_contacts, get_contact, list_appointments, list_opportunities</li>
                  <li>Escrita: create_note, create_task, modify_tag, update_field</li>
                </ul>
              </div>
              <div>
                <p className="font-medium mb-1">Fora do V1 (próximas fases)</p>
                <ul className="list-disc pl-5 text-xs text-gray-600 space-y-0.5">
                  <li>Proatividade (briefings antes de reunião, alertas de opportunity parada, etc)</li>
                  <li>Scheduler (&ldquo;me lembra amanhã 10h&rdquo;)</li>
                  <li>Handoff do sales/recruitment (quando IA trava, avisa rep)</li>
                  <li>Tools avançadas: book_appointment, send_message_to_lead, bulk, undo</li>
                </ul>
              </div>
              <div>
                <p className="font-medium mb-1">Como o rep usa em prod</p>
                <p className="text-xs text-gray-600">
                  Rep manda WhatsApp pro número dedicado do Sparkbot (a ser comprado). Primeira
                  msg recebe termos de uso. Após aceitar, pode pedir ações em texto/áudio/foto/doc.
                  Ações executam no GHL da location do rep.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </PageWrapper>
  );
}
