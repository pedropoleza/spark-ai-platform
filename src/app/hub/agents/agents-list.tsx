"use client";

import Link from "next/link";
import { useState } from "react";
import { AMark, StatusBadge, ChannelChip, PriceBadge } from "@/components/hub/primitives";
import type { HubAgentView } from "@/components/hub/types";

const TEMPLATE_LABEL: Record<string, string> = {
  sparkbot: "SparkBot",
  sales: "Vendas",
  recruitment: "Recrutamento",
  custom: "Personalizado",
};

type Filter = "all" | "active" | "paused";
type TemplateFilter = "all" | "sparkbot" | "sales" | "recruitment" | "custom";

export function AgentsList({ agents }: { agents: HubAgentView[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  // Etapa 3.4 (Pedro 2026-05-28): filtro por template_key adicional.
  const [templateFilter, setTemplateFilter] = useState<TemplateFilter>("all");

  const list = agents.filter((a) => {
    if (filter !== "all" && a.status !== filter) return false;
    if (templateFilter !== "all" && a.template_key !== templateFilter) return false;
    return true;
  });
  const counts = {
    all: agents.length,
    active: agents.filter((a) => a.status === "active").length,
    paused: agents.filter((a) => a.status === "paused").length,
  };

  const tabs: [Filter, string][] = [
    ["all", "Todos"],
    ["active", "Ativos"],
    ["paused", "Pausados"],
  ];

  // Conta agentes por template pra mostrar nas opções (só templates que existem
  // na location pra não poluir a UI com "Personalizado (0)").
  const templateCounts: Record<string, number> = {};
  for (const a of agents) {
    templateCounts[a.template_key] = (templateCounts[a.template_key] || 0) + 1;
  }
  const templateOptions: TemplateFilter[] = [
    "all",
    ...(["sparkbot", "sales", "recruitment", "custom"] as TemplateFilter[]).filter(
      (k) => templateCounts[k as string] && templateCounts[k as string] > 0,
    ),
  ];

  return (
    <div className="card">
      <div className="card-hd" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 4 }}>
          {tabs.map(([k, l]) => (
            <button
              key={k}
              className={"btn btn--sm " + (filter === k ? "btn--soft" : "btn--quiet")}
              onClick={() => setFilter(k)}
            >
              {l} <span className="muted">{counts[k]}</span>
            </button>
          ))}
        </div>
        {templateOptions.length > 2 && (
          <select
            value={templateFilter}
            onChange={(e) => setTemplateFilter(e.target.value as TemplateFilter)}
            className="input"
            style={{ fontSize: 12.5, padding: "4px 8px", maxWidth: 200 }}
            aria-label="Filtrar por tipo de agente"
          >
            {templateOptions.map((k) => (
              <option key={k} value={k}>
                {k === "all"
                  ? "Todos os tipos"
                  : `${TEMPLATE_LABEL[k as string] || k} (${templateCounts[k as string] || 0})`}
              </option>
            ))}
          </select>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          {list.length} {list.length === 1 ? "agente" : "agentes"}
        </span>
      </div>

      {list.length === 0 ? (
        <div className="empty">Nenhum agente neste filtro.</div>
      ) : (
        <div>
          {list.map((a) => (
            <Link
              key={a.id}
              href={`/hub/agents/${a.id}`}
              className="lrow lrow--agent"
              style={{ padding: 16 }}
            >
              <AMark templateKey={a.template_key} size="lg" />
              <div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>{a.name}</div>
                <div className="row" style={{ gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                    {TEMPLATE_LABEL[a.template_key] || a.template_key}
                  </span>
                  {a.since && (
                    <>
                      <span style={{ color: "var(--ink-5)" }}>·</span>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{a.since}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="row wrap lrow-ch" style={{ gap: 12 }}>
                {a.channels.map((c) => (
                  <ChannelChip key={c} name={c} />
                ))}
              </div>
              <StatusBadge status={a.status} />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <PriceBadge included={a.included} entitled={a.entitled} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
