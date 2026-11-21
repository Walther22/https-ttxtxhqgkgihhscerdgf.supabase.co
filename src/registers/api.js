// Small helper for talking to Supabase with the signed-in person's token.
// The portal calls Supabase's REST and Storage endpoints directly with fetch,
// so this follows the same approach and adds no libraries.

export const AREAS = ["lockers", "keys", "issues"];

export function createApi(baseUrl, anonKey, token) {
  const headers = (extra = {}) => ({
    apikey: anonKey,
    Authorization: `Bearer ${token}`,
    ...extra,
  });

  async function parse(res) {
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const raw =
        (data && (data.message || data.error_description || data.msg || data.error)) ||
        `Request failed (${res.status})`;
      const err = new Error(
        /jwt expired/i.test(String(raw))
          ? "Your session has expired. Sign out and sign in again."
          : String(raw)
      );
      err.code = data && data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const json = { "Content-Type": "application/json" };

  return {
    select: (path) =>
      fetch(`${baseUrl}/rest/v1/${path}`, { headers: headers() }).then(parse),

    rpc: (name, args = {}) =>
      fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: headers(json),
        body: JSON.stringify(args),
      }).then(parse),

    insert: (table, row) =>
      fetch(`${baseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: headers({ ...json, Prefer: "return=minimal" }),
        body: JSON.stringify(row),
      }).then(parse),

    update: (table, filter, patch) =>
      fetch(`${baseUrl}/rest/v1/${table}?${filter}`, {
        method: "PATCH",
        headers: headers({ ...json, Prefer: "return=minimal" }),
        body: JSON.stringify(patch),
      }).then(parse),

    uploadPhoto: (path, blob) =>
      fetch(`${baseUrl}/storage/v1/object/venue-issue-photos/${path}`, {
        method: "POST",
        headers: headers({ "Content-Type": blob.type || "image/jpeg" }),
        body: blob,
      }).then(parse),

    // Returns { [path]: fullUrl } for private photos, valid for an hour.
    signedPhotoUrls: async (paths) => {
      if (!paths.length) return {};
      const data = await fetch(`${baseUrl}/storage/v1/object/sign/venue-issue-photos`, {
        method: "POST",
        headers: headers(json),
        body: JSON.stringify({ expiresIn: 3600, paths }),
      }).then(parse);
      const map = {};
      (data || []).forEach((item) => {
        if (item.signedURL) map[item.path] = `${baseUrl}/storage/v1${item.signedURL}`;
      });
      return map;
    },
  };
}

// What this person may do: "none" | "view" | "edit" for each area, plus admin.
export async function loadRegisterAccess(api) {
  const result = { lockers: "none", keys: "none", issues: "none", admin: false };
  await Promise.all([
    ...AREAS.map(async (area) => {
      try {
        const level = await api.rpc("register_access_level", { p_register: area });
        result[area] = ["report", "view", "edit"].includes(level) ? level : "none";
      } catch {
        result[area] = "none";
      }
    }),
    (async () => {
      try {
        result.admin = (await api.rpc("is_register_admin")) === true;
      } catch {
        result.admin = false;
      }
    })(),
  ]);
  return result;
}

export function formatDate(value) {
  if (!value) return "";
  const [y, m, d] = String(value).split("-");
  return y && m && d ? `${d}/${m}/${y}` : value;
}

export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
