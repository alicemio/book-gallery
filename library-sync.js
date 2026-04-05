/**
 * Cloud sync: manifest photos (`library_items`) + cropped uploads (`library_uploads` + Storage).
 * Requires supabase-config.js, Supabase UMD, and SQL in supabase-schema.sql.
 */
const LibrarySync = (() => {
  let client = null;
  let channel = null;
  const UPLOAD_BUCKET = "library-uploads";

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

    uploadBucket: UPLOAD_BUCKET,

    async pull() {
      const sb = getClient();
      if (!sb) return [];
      const { data, error } = await sb
        .from("library_items")
        .select("image_path,category,notes");
      if (error) throw error;
      return data || [];
    },

    async pullUploads() {
      const sb = getClient();
      if (!sb) return [];
      const { data, error } = await sb
        .from("library_uploads")
        .select(
          "id,caption,category,storage_path,updated_at,source_static_path,source_upload_id"
        )
        .order("updated_at", { ascending: true });
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

    getPublicUrlForUpload(storagePath) {
      const sb = getClient();
      if (!sb) return "";
      const { data } = sb.storage.from(UPLOAD_BUCKET).getPublicUrl(storagePath);
      return data?.publicUrl ?? "";
    },

    async uploadImageBlob(storagePath, blob, contentType = "image/jpeg") {
      const sb = getClient();
      if (!sb) return;
      const { error } = await sb.storage.from(UPLOAD_BUCKET).upload(storagePath, blob, {
        contentType,
        upsert: true,
      });
      if (error) console.error("LibrarySync.uploadImageBlob", error);
    },

    async upsertUploadRecord(record) {
      const sb = getClient();
      if (!sb) return;
      const { error } = await sb.from("library_uploads").upsert(
        {
          id: record.id,
          caption: record.caption ?? "",
          category: record.category ?? "",
          storage_path: record.storage_path,
          updated_at: new Date().toISOString(),
          source_static_path: record.source_static_path ?? null,
          source_upload_id: record.source_upload_id ?? null,
        },
        { onConflict: "id" }
      );
      if (error) console.error("LibrarySync.upsertUploadRecord", error);
    },

    async deleteUpload(remoteId, storagePath) {
      const sb = getClient();
      if (!sb) return;
      const { error: delErr } = await sb
        .from("library_uploads")
        .delete()
        .eq("id", remoteId);
      if (delErr) console.error("LibrarySync.deleteUpload row", delErr);
      const { error: stErr } = await sb.storage.from(UPLOAD_BUCKET).remove([storagePath]);
      if (stErr) console.error("LibrarySync.deleteUpload storage", stErr);
    },

    subscribe(onChange) {
      const sb = getClient();
      if (!sb || typeof onChange !== "function") return;
      if (channel) {
        sb.removeChannel(channel);
        channel = null;
      }
      channel = sb
        .channel("library_all_changes")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "library_items" },
          () => onChange()
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "library_uploads" },
          () => onChange()
        )
        .subscribe();
    },
  };
})();

window.LibrarySync = LibrarySync;
