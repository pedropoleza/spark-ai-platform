import { createClient } from "@supabase/supabase-js";
// Import com efeito colateral: valida env vars na primeira vez que admin.ts
// é carregado — qualquer API route que toca DB vai trazer isso junto.
import "@/lib/utils/env";

// Client principal - AI Agent Hub project
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

// Client para o projeto de tokens GHL (read-only)
export function createGHLTokenClient() {
  return createClient(
    process.env.GHL_TOKEN_SUPABASE_URL!,
    process.env.GHL_TOKEN_SUPABASE_SERVICE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
