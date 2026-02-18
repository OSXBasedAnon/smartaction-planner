import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { getSupabasePublishableKey, getSupabaseUrl } from "@/lib/env";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    getSupabaseUrl(),
    getSupabasePublishableKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(items: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          for (const item of items) {
            cookieStore.set(item.name, item.value, item.options as Parameters<typeof cookieStore.set>[2]);
          }
        }
      }
    }
  );
}
