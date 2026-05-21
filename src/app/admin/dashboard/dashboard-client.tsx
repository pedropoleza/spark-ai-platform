"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw } from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1000;
type RangePreset = "24h" | "7d" | "30d" | "custom";
const PRESET_LABELS: Record<RangePreset, string> = {
  "24h": "24h",
  "7d": "7 dias",
  "30d": "30 dias",
  custom: "Custom",
};
import { OverviewTab } from "./tabs/overview-tab";
import { BillingTab } from "./tabs/billing-tab";
import { FeaturesTab } from "./tabs/features-tab";
import { BulkTab } from "./tabs/bulk-tab";
import { RepsTab } from "./tabs/reps-tab";
import { FollowupsTab } from "./tabs/followups-tab";
import { SignalsClient } from "../signals/signals-client";

type DashboardData = {
  ok: boolean;
  cached?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  overview?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  billing?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  features?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bulk?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reps?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  followups?: any;
};

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  // Filtro de data (Pedro 2026-05-21): aplica no Overview inteiro. Default 7 dias.
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customFrom, setCustomFrom] = useState(""); // yyyy-mm-dd
  const [customTo, setCustomTo] = useState(""); // yyyy-mm-dd

  // Lê tab da URL (suporta /admin/dashboard?tab=signals)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab && ["overview", "billing", "features", "bulk", "reps", "followups", "signals"].includes(tab)) {
      setActiveTab(tab);
    }
  }, []);

  // Deriva o range ISO [from, to). Presets ancoram em "agora" (recalcula a cada
  // fetch, então o Refresh desliza a janela). Custom usa as datas locais
  // escolhidas (from 00:00 → to 23:59:59 do dia). Custom sem datas → cai pra 7d.
  const computeRange = useCallback((): { fromISO: string; toISO: string } => {
    const now = new Date();
    const toISO = now.toISOString();
    if (preset === "custom" && customFrom && customTo) {
      const f = new Date(`${customFrom}T00:00:00`);
      const t = new Date(`${customTo}T23:59:59.999`);
      if (!isNaN(f.getTime()) && !isNaN(t.getTime()) && f < t) {
        return { fromISO: f.toISOString(), toISO: t.toISOString() };
      }
    }
    const days = preset === "24h" ? 1 : preset === "30d" ? 30 : 7;
    return { fromISO: new Date(now.getTime() - days * DAY_MS).toISOString(), toISO };
  }, [preset, customFrom, customTo]);

  const fetchData = useCallback(async (fresh: boolean = false) => {
    setLoading(true);
    try {
      const { fromISO, toISO } = computeRange();
      const params = new URLSearchParams({ tab: "all", from: fromISO, to: toISO });
      if (fresh) params.set("fresh", "1");
      const res = await fetch(`/api/admin/dashboard?${params.toString()}`);
      const d = await res.json();
      setData(d);
    } catch (err) {
      console.error("dashboard fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [computeRange]);

  // Refetch quando o range muda (preset/custom) ou no mount.
  useEffect(() => {
    fetchData(false);
  }, [fetchData]);

  // Atualiza URL quando muda tab
  const handleTabChange = (v: string) => {
    setActiveTab(v);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", v);
    window.history.replaceState({}, "", url.toString());
  };

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      <div className="flex flex-col gap-4 mb-6 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-bold">SparkBot Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Visão geral do bot — uso, billing, features, signals
            {data?.cached && <span className="ml-2 text-xs text-amber-600">(cache 60s)</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Filtro de data — aplica no Overview */}
          <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
            {(["24h", "7d", "30d", "custom"] as RangePreset[]).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={preset === p ? "default" : "ghost"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setPreset(p)}
              >
                {PRESET_LABELS[p]}
              </Button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="flex items-center gap-1">
              <Input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-7 w-[140px] text-xs"
              />
              <span className="text-muted-foreground text-xs">→</span>
              <Input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-7 w-[140px] text-xs"
              />
            </div>
          )}
          <Button variant="outline" size="sm" className="h-7" onClick={() => fetchData(true)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="overview">📊 Overview</TabsTrigger>
          <TabsTrigger value="billing">💰 Billing</TabsTrigger>
          <TabsTrigger value="features">🚀 Features</TabsTrigger>
          <TabsTrigger value="bulk">📨 Bulk</TabsTrigger>
          <TabsTrigger value="followups">🔄 Follow-ups</TabsTrigger>
          <TabsTrigger value="reps">👥 Reps</TabsTrigger>
          <TabsTrigger value="signals">🚨 Signals</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab data={data?.overview} loading={loading} />
        </TabsContent>
        <TabsContent value="billing" className="mt-6">
          <BillingTab data={data?.billing} loading={loading} />
        </TabsContent>
        <TabsContent value="features" className="mt-6">
          <FeaturesTab data={data?.features} loading={loading} />
        </TabsContent>
        <TabsContent value="bulk" className="mt-6">
          <BulkTab data={data?.bulk} loading={loading} />
        </TabsContent>
        <TabsContent value="followups" className="mt-6">
          <FollowupsTab data={data?.followups} loading={loading} />
        </TabsContent>
        <TabsContent value="reps" className="mt-6">
          <RepsTab data={data?.reps} loading={loading} />
        </TabsContent>
        <TabsContent value="signals" className="mt-6">
          <SignalsClient />
        </TabsContent>
      </Tabs>
    </div>
  );
}
