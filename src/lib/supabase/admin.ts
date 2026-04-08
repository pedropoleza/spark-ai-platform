import { createClient } from "@supabase/supabase-js";

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
