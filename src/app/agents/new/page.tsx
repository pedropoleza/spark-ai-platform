"use client";

/**
 * Wizard de criação de agente — flagship da reestruturação "Composable/Blueprint"
 * (Plataforma Modular, Fase 3). Fluxo: tipo → conexão → módulos → revisar → criar.
 * Estética: fundo blueprint, display Bricolage, blocos de módulo táteis, acento
 * lima pra selecionado/conectado. Lê /api/agent-platform/catalog; cria via
 * POST /api/agent-platform/agents.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bot, Users, Sparkles, CalendarClock, Megaphone, ShieldCheck, Clock, MessageSquareText,
  Wrench, BookOpen, ListChecks, Check, Lock, ArrowRight, ArrowLeft, Loader2,
  MessageCircle, Camera, Plug,
} from "lucide-react";

interface Template {
  key: string;
  name: string;
  audience: "rep" | "lead";
  description: string | null;
  default_modules: string[];
}
interface ModuleItem {
  key: string;
  name: string;
  category: string;
  audience_scope: "rep" | "lead" | "both";
}
interface Catalog {
  templates: Template[];
  modules: ModuleItem[];
  activeCapabilities: string[];
  isAdmin: boolean;
  capabilityByTemplate: Record<string, string | null>;
}

const STEPS = ["Tipo", "Conexão", "Módulos", "Revisar"] as const;

// ícone + cor por template
const TEMPLATE_META: Record<string, { icon: typeof Bot; tagline: string }> = {
  sparkbot: { icon: Bot, tagline: "Seu copiloto. Fala com você, opera o CRM." },
  sales: { icon: Megaphone, tagline: "Qualifica e agenda leads de venda." },
  recruitment: { icon: Users, tagline: "Qualifica e agenda candidatos." },
  custom: { icon: Sparkles, tagline: "Monte do zero — evento, nicho, temporário." },
};

const MODULE_ICON: Record<string, typeof Bot> = {
  behavior: MessageSquareText,
  active_hours: Clock,
  followup: ListChecks,
  qualification: BookOpen,
  scheduling: CalendarClock,
  compliance: ShieldCheck,
  channel: Plug,
  crm_ops: Wrench,
  knowledge: BookOpen,
  bulk: Megaphone,
};

const CHANNELS = [
  { id: "WhatsApp", label: "WhatsApp", icon: MessageCircle },
  { id: "Instagram", label: "Instagram DM", icon: Camera },
];

export default function NewAgentWizard() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[]>(["WhatsApp"]);
  const [moduleKeys, setModuleKeys] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetch("/api/agent-platform/catalog")
      .then((r) => r.json())
      .then((d) => {
        if (d.templates) setCatalog(d);
        else setLoadErr("Não consegui carregar o catálogo.");
      })
      .catch(() => setLoadErr("Falha de rede ao carregar o catálogo."));
  }, []);

  const template = useMemo(
    () => catalog?.templates.find((t) => t.key === templateKey) || null,
    [catalog, templateKey],
  );
  const audience = template?.audience ?? "lead";

  // módulos disponíveis pra audiência do template
  const availableModules = useMemo(() => {
    if (!catalog || !template) return [];
    return catalog.modules.filter(
      (m) => m.audience_scope === "both" || m.audience_scope === template.audience,
    );
  }, [catalog, template]);

  const isLocked = useCallback(
    (t: Template) => {
      if (!catalog) return false;
      const cap = catalog.capabilityByTemplate[t.key];
      if (cap === null) return false; // incluso
      if (catalog.isAdmin) return false; // admin libera
      return !catalog.activeCapabilities.includes(cap || "");
    },
    [catalog],
  );

  const pickTemplate = (t: Template) => {
    setTemplateKey(t.key);
    setModuleKeys(t.default_modules || []); // pré-seleciona os módulos do template
    setName("");
  };
  const toggleModule = (k: string) =>
    setModuleKeys((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const toggleChannel = (id: string) =>
    setChannels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canNext =
    (step === 0 && !!templateKey && (catalog && template ? !isLocked(template) : false)) ||
    (step === 1 && (audience === "rep" || channels.length > 0)) ||
    (step === 2 && moduleKeys.length > 0) ||
    step === 3;

  const create = async () => {
    if (!templateKey) return;
    setCreating(true);
    try {
      const res = await fetch("/api/agent-platform/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_key: templateKey, name: name.trim() || undefined, module_keys: moduleKeys }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Não consegui criar o agente.");
        return;
      }
      toast.success("Agente criado! 🎉");
      router.push("/dashboard");
    } catch {
      toast.error("Falha de rede ao criar.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-paper bg-blueprint bg-[length:28px_28px] text-ink">
      <div className="mx-auto max-w-3xl px-5 py-10 md:py-14">
        {/* HEADER */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-600">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-spark-400" />
            Spark Leads · Plataforma de Agentes
          </div>
          <h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight md:text-5xl">
            Montar um agente
          </h1>
          <p className="mt-1 text-[15px] text-neutral-500">
            Escolha um tipo, conecte um canal e encaixe os módulos. Como peças.
          </p>
        </div>

        {/* PROGRESS — dots conectados */}
        <Progress step={step} />

        {/* CONTENT */}
        {loadErr ? (
          <div className="mt-10 rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700">{loadErr}</div>
        ) : !catalog ? (
          <div className="mt-16 flex justify-center text-neutral-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div key={step} className="mt-8 animate-wizard-in">
            {step === 0 && (
              <Section title="Que tipo de agente?" hint="O SparkBot vem incluso. Os outros são módulos adicionais.">
                <div className="grid gap-3 sm:grid-cols-2">
                  {catalog.templates.map((t) => (
                    <TemplateCard
                      key={t.key}
                      t={t}
                      selected={templateKey === t.key}
                      locked={isLocked(t)}
                      onClick={() => !isLocked(t) && pickTemplate(t)}
                    />
                  ))}
                </div>
              </Section>
            )}

            {step === 1 && (
              <Section
                title={audience === "rep" ? "Conexão" : "Por onde ele fala?"}
                hint={audience === "rep" ? "O SparkBot fala direto com você no WhatsApp — sem número novo." : "Os canais já conectados na sub-account deste agente."}
              >
                {audience === "rep" ? (
                  <div className="flex items-center gap-3 rounded-2xl border border-neutral-200/70 bg-white p-5 shadow-sm">
                    <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Bot className="h-5 w-5" /></span>
                    <div>
                      <div className="font-medium">Direto com você</div>
                      <div className="text-sm text-neutral-500">Rep-facing · usa seu próprio WhatsApp.</div>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {CHANNELS.map((c) => (
                      <ChannelChip key={c.id} c={c} selected={channels.includes(c.id)} onClick={() => toggleChannel(c.id)} />
                    ))}
                  </div>
                )}
              </Section>
            )}

            {step === 2 && (
              <Section title="Encaixe os módulos" hint="Cada módulo dá uma capacidade ao agente. Ligue os que fizerem sentido.">
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {availableModules.map((m) => (
                    <ModuleBlock key={m.key} m={m} selected={moduleKeys.includes(m.key)} onClick={() => toggleModule(m.key)} />
                  ))}
                </div>
              </Section>
            )}

            {step === 3 && template && (
              <Section title="Confere e cria" hint="Tudo certo? É só dar um nome.">
                <div className="rounded-2xl border border-neutral-200/70 bg-white p-5 shadow-sm">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">Nome do agente</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={template.name}
                    className="mt-1.5 w-full rounded-xl border border-neutral-200 bg-paper px-4 py-2.5 text-[15px] outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-100"
                  />
                  <div className="mt-5 grid grid-cols-2 gap-y-3 text-sm">
                    <Meta k="Tipo" v={template.name} />
                    <Meta k="Audiência" v={audience === "rep" ? "Fala com você" : "Fala com leads"} />
                    <Meta k="Conexão" v={audience === "rep" ? "Seu WhatsApp" : channels.join(" · ") || "—"} />
                    <Meta k="Preço" v={audience === "rep" ? "Incluso" : "$50/mês"} accent={audience === "lead"} />
                  </div>
                  <div className="mt-4 border-t border-neutral-100 pt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">Módulos ({moduleKeys.length})</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {moduleKeys.map((k) => {
                        const Icon = MODULE_ICON[k] || Wrench;
                        const m = catalog.modules.find((x) => x.key === k);
                        return (
                          <span key={k} className="inline-flex items-center gap-1.5 rounded-lg border border-spark-300 bg-spark-50 px-2.5 py-1 text-[13px] font-medium text-spark-700">
                            <Icon className="h-3.5 w-3.5" /> {m?.name || k}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </Section>
            )}
          </div>
        )}

        {/* NAV */}
        {catalog && !loadErr && (
          <div className="mt-8 flex items-center justify-between">
            <button
              onClick={() => (step === 0 ? router.push("/dashboard") : setStep((s) => s - 1))}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium text-neutral-500 transition hover:bg-neutral-100 hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" /> {step === 0 ? "Cancelar" : "Voltar"}
            </button>
            {step < 3 ? (
              <button
                onClick={() => canNext && setStep((s) => s + 1)}
                disabled={!canNext}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-[0_6px_16px_rgba(22,117,242,0.28)] transition hover:bg-brand-600 hover:shadow-[0_8px_20px_rgba(22,117,242,0.32)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                Próximo <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={create}
                disabled={creating}
                className="inline-flex items-center gap-2 rounded-xl bg-ink px-6 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:bg-neutral-800 disabled:opacity-50"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-spark-400" />}
                Criar agente
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================ subcomponentes

function Progress({ step }: { step: number }) {
  return (
    <div className="flex items-center">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`grid h-7 w-7 place-items-center rounded-[8px] text-[12px] font-bold transition ${
                  done ? "bg-spark-400 text-ink" : active ? "bg-brand-500 text-white ring-4 ring-brand-100" : "bg-white text-neutral-400 ring-1 ring-neutral-200"
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`text-[11px] font-semibold uppercase tracking-wide ${active ? "text-brand-600" : done ? "text-spark-600" : "text-neutral-400"}`}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className="mx-2 mb-5 h-[2px] flex-1 rounded-full bg-neutral-200">
                <div className={`h-full rounded-full transition-all duration-500 ${done ? "w-full bg-spark-400" : "w-0"}`} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight">{title}</h2>
      {hint && <p className="mb-5 mt-1 text-sm text-neutral-500">{hint}</p>}
      {children}
    </div>
  );
}

function TemplateCard({ t, selected, locked, onClick }: { t: Template; selected: boolean; locked: boolean; onClick: () => void }) {
  const meta = TEMPLATE_META[t.key] || { icon: Sparkles, tagline: t.description || "" };
  const Icon = meta.icon;
  const included = t.key === "sparkbot";
  return (
    <button
      onClick={onClick}
      disabled={locked}
      className={`group relative overflow-hidden rounded-2xl border bg-white p-5 text-left transition-all ${
        selected
          ? "border-spark-400 shadow-[0_0_0_3px_rgba(163,230,53,0.35),0_10px_24px_rgba(15,17,21,0.08)]"
          : locked
          ? "cursor-not-allowed border-neutral-200/60 opacity-60"
          : "border-neutral-200/70 shadow-sm hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-[0_10px_24px_rgba(15,17,21,0.08)]"
      }`}
    >
      <div className="flex items-start justify-between">
        <span className={`grid h-11 w-11 place-items-center rounded-xl transition ${selected ? "bg-spark-100 text-spark-700" : "bg-brand-50 text-brand-600"}`}>
          <Icon className="h-5 w-5" />
        </span>
        {locked ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-500"><Lock className="h-3 w-3" /> Bloqueado</span>
        ) : (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${included ? "bg-spark-100 text-spark-700" : "bg-brand-50 text-brand-700"}`}>
            {included ? "Incluso" : "$50/mês"}
          </span>
        )}
      </div>
      <div className="mt-3 font-display text-lg font-bold tracking-tight">{t.name}</div>
      <div className="mt-0.5 text-[13px] leading-snug text-neutral-500">{meta.tagline}</div>
      <div className="mt-3">
        <span className="inline-flex items-center gap-1 rounded-md bg-neutral-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          {t.audience === "rep" ? "fala com você" : "fala com leads"}
        </span>
      </div>
      {selected && <span className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-spark-400 text-ink"><Check className="h-3 w-3" /></span>}
    </button>
  );
}

function ChannelChip({ c, selected, onClick }: { c: { id: string; label: string; icon: typeof Bot }; selected: boolean; onClick: () => void }) {
  const Icon = c.icon;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-2xl border bg-white p-4 text-left transition ${
        selected ? "border-spark-400 shadow-[0_0_0_3px_rgba(163,230,53,0.3)]" : "border-neutral-200/70 shadow-sm hover:border-brand-300"
      }`}
    >
      <span className={`grid h-10 w-10 place-items-center rounded-xl ${selected ? "bg-spark-100 text-spark-700" : "bg-brand-50 text-brand-600"}`}><Icon className="h-5 w-5" /></span>
      <div className="flex-1">
        <div className="font-medium">{c.label}</div>
        <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-spark-400" /> conectado
        </div>
      </div>
      {selected && <Check className="h-4 w-4 text-spark-600" />}
    </button>
  );
}

function ModuleBlock({ m, selected, onClick }: { m: ModuleItem; selected: boolean; onClick: () => void }) {
  const Icon = MODULE_ICON[m.category] || Wrench;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border p-3.5 text-left transition ${
        selected
          ? "border-spark-400 bg-spark-50/60 shadow-[0_0_0_2px_rgba(163,230,53,0.3)]"
          : "border-dashed border-neutral-300 bg-white/60 hover:border-brand-300 hover:bg-white"
      }`}
    >
      <span className={`grid h-9 w-9 place-items-center rounded-lg transition ${selected ? "bg-spark-200 text-spark-700" : "bg-neutral-100 text-neutral-500"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 text-[14px] font-medium">{m.name}</span>
      <span className={`grid h-5 w-5 place-items-center rounded-md border transition ${selected ? "border-spark-400 bg-spark-400 text-ink" : "border-neutral-300 text-transparent"}`}>
        <Check className="h-3 w-3" />
      </span>
    </button>
  );
}

function Meta({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-400">{k}</div>
      <div className={`text-[15px] font-medium ${accent ? "text-spark-700" : "text-ink"}`}>{v}</div>
    </div>
  );
}
