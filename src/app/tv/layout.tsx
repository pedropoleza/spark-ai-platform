/**
 * TV do estande — attract loop (plano: _planning/tv-estande-attract-loop.md).
 * Palco 1920×1080 dark premium, troca de tela a cada 10s, zero rede em runtime
 * (Jakarta self-hosted via next/font; assets locais; QR pré-gerado no build).
 */
import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./tv.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Spark Leads · TV",
  robots: "noindex",
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function TvLayout({ children }: { children: React.ReactNode }) {
  return <div className={jakarta.className}>{children}</div>;
}
