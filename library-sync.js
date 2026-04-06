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
        .select("image_path,category,notes,updated_at");
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

    /** @returns {Promise<{ error: Error | null }>} */
    async uploadImageBlob(storagePath, blob, contentType = "image/jpeg") {
      const sb = getClient();
      if (!sb) return { error: new Error("Supabase client unavailable") };
      const { error } = await sb.storage.from(UPLOAD_BUCKET).upload(storagePath, blob, {
        contentType,
        upsert: true,
      });
      if (error) {
        console.error("LibrarySync.uploadImageBlob", error);
        return { error: new Error(error.message || String(error)) };
      }
      return { error: null };
    },

    /** @returns {Promise<{ error: Error | null }>} */
    async upsertUploadRecord(record) {
      const sb = getClient();
      if (!sb) return { error: new Error("Supabase client unavailable") };
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
      if (error) {
        console.error("LibrarySync.upsertUploadRecord", error);
        return { error: new Error(error.message || String(error)) };
      }
      return { error: null };
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

    /** @returns {Promise<{ hidden_static_paths?: string[], updated_at?: string } | null>} */
    async pullGalleryPrefs() {
      const sb = getClient();
      if (!sb) return null;
      const { data, error } = await sb
        .from("library_gallery_prefs")
        .select("hidden_static_paths,updated_at")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    /** @param {string[]} paths manifest paths `images/…` currently hidden */
    async pushGalleryPrefs(paths) {
      const sb = getClient();
      if (!sb) return { error: new Error("Supabase client unavailable") };
      const unique = [
        ...new Set(
          (paths || [])
            .filter((p) => typeof p === "string")
            .map((p) => p.trim())
            .filter(Boolean)
        ),
      ];
      const { error } = await sb.from("library_gallery_prefs").upsert(
        {
          id: 1,
          hidden_static_paths: unique,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );
      if (error) {
        console.error("LibrarySync.pushGalleryPrefs", error);
        return { error: new Error(error.message || String(error)) };
      }
      return { error: null };
    },

    /**
     * @param {() => void} onChange
     * @param {(status: string, err?: unknown) => void} [onChannelStatus] — e.g. CHANNEL_ERROR / TIMED_OUT on mobile
     */
    subscribe(onChange, onChannelStatus) {
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
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "library_gallery_prefs" },
          () => onChange()
        )
        .subscribe((status, err) => {
          if (typeof onChannelStatus === "function") onChannelStatus(status, err);
        });
    },

    /**
     * Insert a visitor request; requires `book_inquiries` table and INSERT policy (see supabase-schema.sql).
     * @param {{ name: string, email: string, message: string, books: unknown }} payload
     */
    async submitBookInquiry(payload) {
      const sb = getClient();
      if (!sb) throw new Error("Library not connected");
      const { error } = await sb.from("book_inquiries").insert({
        requester_name: payload.name.trim(),
        requester_email: payload.email.trim(),
        message: (payload.message || "").trim(),
        books: payload.books,
      });
      if (error) throw error;
    },
  };
})();

window.LibrarySync = LibrarySync;
