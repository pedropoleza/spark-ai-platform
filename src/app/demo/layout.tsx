/**
 * Demo de convenção (Fase 1) — layout fullscreen tipo quiosque.
 * Implementa o handoff do Claude Design: tema claro, cyan #0FB5E1, Plus Jakarta Sans,
 * palco 1366×1024 auto-escalado. Sem auth (middleware só gateia /admin*).
 *
 * Plus Jakarta Sans via next/font (self-hosted no build) — não depende do
 * Google Fonts CDN em runtime, então funciona mesmo com wifi ruim no estande.
 */
import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./demo.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SparkBot · Demonstração",
  robots: "noindex",
  // PWA de quiosque (Pedro 2026-06-11): "Adicionar à Tela de Início" no iPad
  // abre fullscreen, sem a barra de endereço do Safari.
  manifest: "/demo/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SparkBot Demo",
  },
  icons: {
    apple: "/demo/icon-180.png",
  },
  formatDetection: { telephone: false },
  // Next novo só emite "mobile-web-app-capable"; iPadOS antigo lê a tag apple-.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  minimumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return <div className={jakarta.className}>{children}</div>;
}
