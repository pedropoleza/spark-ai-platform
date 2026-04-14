"use client";

import { useEffect, useState, useCallback } from "react";
import { Save, Loader2, Copy, CheckCircle2, Key, Globe, Shield } from "lucide-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Sao_Paulo", label: "Brasilia (BRT)" },
  { value: "UTC", label: "UTC" },
];

interface Settings {
  openai_api_key: string | null;
  has_custom_key: boolean;
  default_timezone: string;
  daily_message_limit: number;
  cost_alert_threshold: number;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    openai_api_key: null,
    has_custom_key: false,
    default_timezone: "America/New_York",
    daily_message_limit: 500,
    cost_alert_threshold: 50,
  });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [locationId, setLocationId] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setSettings(data.settings);
        setWebhookUrl(data.webhook_url || "");
        setLocationId(data.location_id || "");
      }
    } catch (e) {
      console.error("Erro ao buscar settings:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        default_timezone: settings.default_timezone,
        daily_message_limit: settings.daily_message_limit,
        cost_alert_threshold: settings.cost_alert_threshold,
      };
      if (newApiKey) body.openai_api_key = newApiKey;

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setSaved(true);
        setNewApiKey("");
        await fetchSettings();
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (e) {
      console.error("Erro ao salvar:", e);
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  if (loading) {
    return (
      <PageWrapper title="Configuracoes">
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper
      title="Configuracoes"
      subtitle="Gerencie as configuracoes da sua conta"
      actions={
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          {saved ? "Salvo!" : "Salvar"}
        </Button>
      }
    >
      <div className="grid gap-6">
        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="w-4 h-4" />
              Webhook
            </CardTitle>
            <CardDescription>
              URL para configurar no aplicativo do Spark para receber mensagens
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">URL do Webhook (Inbound Message)</Label>
              <div className="flex gap-2 mt-1">
                <Input value={webhookUrl} readOnly className="font-mono text-xs bg-gray-50" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(webhookUrl, "webhook")}
                >
                  {copied === "webhook" ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">Location ID</Label>
              <div className="flex gap-2 mt-1">
                <Input value={locationId} readOnly className="font-mono text-xs bg-gray-50" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(locationId, "location")}
                >
                  {copied === "location" ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* API Key */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="w-4 h-4" />
              Chave de API (OpenAI)
            </CardTitle>
            <CardDescription>
              Use sua propria chave de API da OpenAI. Se vazio, usa a chave padrao da plataforma.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {settings.has_custom_key && (
              <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Chave personalizada ativa: {settings.openai_api_key}
              </div>
            )}
            <div>
              <Label className="text-xs">{settings.has_custom_key ? "Substituir chave" : "Adicionar chave"}</Label>
              <Input
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="sk-proj-..."
                className="mt-1"
              />
            </div>
          </CardContent>
        </Card>

        {/* Timezone */}
        <Card>
          <CardHeader>
            <CardTitle>Fuso horario</CardTitle>
          </CardHeader>
          <CardContent>
            <Select
              value={settings.default_timezone}
              onValueChange={(v) => setSettings({ ...settings, default_timezone: v })}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Limites */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Limites e alertas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Limite diario de mensagens</Label>
              <Input
                type="number"
                min={10}
                max={10000}
                value={settings.daily_message_limit}
                onChange={(e) => setSettings({ ...settings, daily_message_limit: Number(e.target.value) })}
                className="mt-1.5 w-32"
              />
              <p className="text-xs text-gray-500 mt-1">
                O agente para de enviar quando atingir este limite
              </p>
            </div>
            <div>
              <Label>Alerta de custo (USD)</Label>
              <Input
                type="number"
                min={1}
                step={10}
                value={settings.cost_alert_threshold}
                onChange={(e) => setSettings({ ...settings, cost_alert_threshold: Number(e.target.value) })}
                className="mt-1.5 w-32"
              />
              <p className="text-xs text-gray-500 mt-1">
                Voce sera notificado quando os gastos com tokens atingirem este valor
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageWrapper>
  );
}
