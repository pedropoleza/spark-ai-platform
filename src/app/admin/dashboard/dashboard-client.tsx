"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
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

  // Lê tab da URL (suporta /admin/dashboard?tab=signals)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab && ["overview", "billing", "features", "bulk", "reps", "followups", "signals"].includes(tab)) {
      setActiveTab(tab);
    }
  }, []);

  const fetchData = useCallback(async (fresh: boolean = false) => {
    setLoading(true);
    try {
      const url = `/api/admin/dashboard?tab=all${fresh ? "&fresh=1" : ""}`;
      const res = await fetch(url);
      const d = await res.json();
      setData(d);
    } catch (err) {
      console.error("dashboard fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">SparkBot Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Visão geral do bot — uso, billing, features, signals
            {data?.cached && <span className="ml-2 text-xs text-amber-600">(cache 60s)</span>}
          </p>
        </div>
        <Button variant="outline" onClick={() => fetchData(true)} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
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
