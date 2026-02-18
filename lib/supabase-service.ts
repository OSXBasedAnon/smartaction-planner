import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceKey, getSupabaseUrl } from "@/lib/env";

export function createSupabaseServiceClient() {
  return createClient(getSupabaseUrl(), getSupabaseServiceKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
