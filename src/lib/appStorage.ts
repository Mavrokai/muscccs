import { supabase } from "./supabase";

export async function storageGet(key: string): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("user_kv")
    .select("value")
    .eq("user_id", user.id)
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return data.value;
}

export async function storageSet(key: string, value: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from("user_kv")
    .upsert({ user_id: user.id, key, value }, { onConflict: "user_id,key" });
}

export async function storageRemove(key: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from("user_kv")
    .delete()
    .eq("user_id", user.id)
    .eq("key", key);
}

export function isElectronDbAvailable(): boolean {
  return false;
}
