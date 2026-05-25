import type { Metadata } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

// Plataforma Modular (Pedro 2026-05-25): fonte de DISPLAY distinta pra a nova UI
// "Composable/Blueprint". Bricolage Grotesque tem caráter "construído" que casa
// com o conceito de montar agente de módulos. Corpo segue --font-sans.
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Spark AI Hub - Agentes de IA",
  description: "Plataforma de configuração de agentes de IA",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className={`${inter.variable} ${bricolage.variable} ${GeistSans.variable} ${GeistMono.variable} font-sans antialiased bg-gray-50 text-gray-900`}>
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
