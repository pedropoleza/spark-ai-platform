/**
 * Layout aninhado pro painel embedded. Next.js root layout (src/app/layout.tsx)
 * é quem renderiza <html>/<body> — aqui só envolvemos o painel pra impedir
 * estilos do dashboard de vazarem.
 */
export const metadata = {
  title: "Sparkbot",
  robots: "noindex",
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: "100vh", background: "#f8fafc" }}>{children}</div>;
}
