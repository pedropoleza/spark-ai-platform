"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, Play, Pause, Check } from "lucide-react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
import { MODULE_LABEL, MODULE_SUBTITLE } from "@/components/hub/module-labels";
import type { HubAgentDetail } from "@/lib/hub/data";

const TEMPLATE_LABEL: Record<string, string> = {
  sparkbot: "SparkBot",
  sales: "Vendas",
  recruitment: "Recrutamento",
  custom: "Personalizado",
};

type Tab = "config" | "messages" | "docs" | "history";

export function AgentDetailView({ detail }: { detail: HubAgentDetail }) {
  const [tab, setTab] = useState<Tab>("config");

  const tabs: { id: Tab; label: string }[] = [
    { id: "config", label: "Configurações" },
    { id: "messages", label: "Mensagens" },
    { id: "docs", label: "Documentos" },
    { id: "history", label: "Histórico" },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ padding: "20px 32px", borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
        <Link href="/hub/agents" className="btn btn--quiet btn--sm" style={{ marginBottom: 12 }}>
          <ChevronLeft /> Voltar para agentes
        </Link>

        <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
          <AMark templateKey={detail.template_key} size="xl" />
          <div className="grow">
            <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 4 }}>
              {TEMPLATE_LABEL[detail.template_key] || detail.template_key}
            </div>
            <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-.018em", margin: 0 }}>{detail.name}</h1>
            <div className="row wrap" style={{ gap: 16, marginTop: 8 }}>
              <StatusBadge status={detail.status} />
              {detail.channels.map((c) => (
                <ChannelChip key={c} name={c} />
              ))}
              <PriceBadge included={detail.included} entitled={detail.entitled} />
              {detail.since && <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{detail.since}</span>}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn--ghost" disabled title="Disponível na próxima fase">
              <Play /> Testar
            </button>
            <button className="btn btn--ghost" disabled title="Disponível na próxima fase">
              {detail.status === "active" ? (
                <>
                  <Pause /> Pausar
                </>
              ) : (
                <>
                  <Play /> Ativar
                </>
              )}
            </button>
            <button className="btn btn--primary" disabled title="Disponível na próxima fase">
              <Check /> Salvar
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs" style={{ background: "var(--surface)", paddingLeft: 32, paddingRight: 32 }}>
        {tabs.map((t) => (
          <button key={t.id} className="tab" aria-current={tab === t.id ? "true" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Conteúdo */}
      <div className="page" style={{ maxWidth: 980 }}>
        {tab === "config" && <ConfigRead detail={detail} />}
        {tab === "messages" && <div className="empty">As conversas deste agente aparecerão aqui.</div>}
        {tab === "docs" && <div className="empty">Os documentos de apoio aparecerão aqui.</div>}
        {tab === "history" && <div className="empty">O histórico de alterações aparecerá aqui.</div>}
      </div>
    </div>
  );
}

function ConfigRead({ detail }: { detail: HubAgentDetail }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div
        className="card"
        style={{ padding: "12px 16px", background: "var(--primary-soft)", border: "none", color: "var(--primary-ink)" }}
      >
        <span style={{ fontSize: 13 }}>
          Esta tela ainda é somente leitura — edição, teste e ativar/pausar chegam na próxima fase.
        </span>
      </div>

      <div>
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>Configurações</h2>
        <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
          <span className="bold" style={{ color: "var(--ink)" }}>
            {detail.modules.length}
          </span>{" "}
          {detail.modules.length === 1 ? "ajuste ligado" : "ajustes ligados"}.
        </p>
      </div>

      {detail.modules.length === 0 ? (
        <div className="card">
          <div className="empty">Este agente ainda não tem módulos compostos.</div>
        </div>
      ) : (
        detail.modules.map((m) => (
          <div key={m.key} className="card">
            <div
              style={{
                padding: "14px 18px",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 14,
                alignItems: "center",
              }}
            >
              <span className={"modcat modcat--" + m.category} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{MODULE_LABEL[m.key] || m.name}</div>
                <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>{MODULE_SUBTITLE[m.key] || ""}</div>
              </div>
              <span className="pill pill--ok">Ligado</span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
