/**
 * Cloud sync for file-based cards (paths like images/…).
 * Requires supabase-config.js, Supabase UMD, and a `library_items` table (see supabase-schema.sql).
 */
const LibrarySync = (() => {
  let client = null;
  let channel = null;

  function getClient() {
    if (client) return client;
    const url = window.SUPABASE_URL;
    const key = window.SUPABASE_ANON_KEY;
    if (!url || !key || typeof window.supabase?.createClient !== "function") {
      return null;
    }
    client = window.supabase.createClient(url, key);
    return client;
  }

  return {
    isConfigured() {
      return !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
    },

    hasClient() {
      return !!getClient();
    },

    async pull() {
      const sb = getClient();
      if (!sb) return [];
      const { data, error } = await sb
        .from("library_items")
        .select("image_path,category,notes");
      if (error) throw error;
      return data || [];
    },

    async push(imagePath, category, notes) {
      const sb = getClient();
      if (!sb) return;
      const { error } = await sb.from("library_items").upsert(
        {
          image_path: imagePath,
          category: category ?? "",
          notes: notes ?? "",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "image_path" }
      );
      if (error) console.error("LibrarySync.push", error);
    },

    async remove(imagePath) {
      const sb = getClient();
      if (!sb) return;
      const { error } = await sb
        .from("library_items")
        .delete()
        .eq("image_path", imagePath);
      if (error) console.error("LibrarySync.remove", error);
    },

    subscribe(onChange) {
      const sb = getClient();
      if (!sb || typeof onChange !== "function") return;
      if (channel) {
        sb.removeChannel(channel);
        channel = null;
      }
      channel = sb
        .channel("library_items_changes")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "library_items" },
          () => onChange()
        )
        .subscribe();
    },
  };
})();

window.LibrarySync = LibrarySync;
