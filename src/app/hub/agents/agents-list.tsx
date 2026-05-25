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

export function AgentsList({ agents }: { agents: HubAgentView[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const list = filter === "all" ? agents : agents.filter((a) => a.status === filter);
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

  return (
    <div className="card">
      <div className="card-hd">
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
              className="lrow"
              style={{ gridTemplateColumns: "48px 1fr 180px 130px 110px", padding: 16 }}
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
              <div className="row wrap" style={{ gap: 12 }}>
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
