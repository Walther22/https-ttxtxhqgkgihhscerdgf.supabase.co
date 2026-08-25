import { useState } from "react";
import associationLogo from "./WASRA-logo-small-300x300.png";

// ---- Fill these in with your Supabase project details ----
const SUPABASE_URL = "https://ttxtxhqgkgihhscerdgf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aL49TtFkyRe0cL3u7cTIuQ_OVYs2qUk";
// This portal calls Supabase's REST + Auth endpoints directly
// with fetch, so it works with no extra libraries. RLS on the
// MemberT table (from the "authenticated" policy) is what
// actually decides who can see rows — the anon key alone
// grants nothing.

const CURRENT_FY_ID = 3;
const CURRENT_FY_LABEL = "FY26";

// Only these columns are shown, in this order. `source` says which
// table the field actually lives on. "derived" columns are computed
// after fetching (not requested directly from the API).
const REPORT_COLUMNS = [
  { key: "MEMID", label: "Member ID", source: "member" },
  { key: "Given Name", label: "Given Name", source: "member" },
  { key: "Surname", label: "Surname", source: "member" },
  { key: "ClubName", label: "Club", source: "derived" },
  { key: "EntryDate", label: "Entry Date", source: "paid" },
];

// Fetched from memberT but not shown directly — used to look up the
// club name and to filter the table by the dropdown.
const CLUB_LINK_FIELD = "Club No";

export default function MemberPortal() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState("");

  const [members, setMembers] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState("");

  const [clubs, setClubs] = useState([]);
  const [selectedClub, setSelectedClub] = useState("all");
  const [nameSearch, setNameSearch] = useState("");

  // "landing" = the home screen with tool buttons; "lookup" = the
  // member report. More views (like practice sign-in) can be added
  // the same way later.
  const [view, setView] = useState("landing");

  async function handleSignIn(e) {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      const res = await fetch(
        `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ email, password }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error_description || data.msg || "Sign in failed");
      }
      setSession(data);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  }

  function openMemberLookup() {
    setView("lookup");
    if (!members && session) {
      fetchReport(session.access_token);
    }
  }

  async function fetchReport(accessToken) {
    setReportLoading(true);
    setReportError("");
    try {
      // Column names with spaces (like "Given Name") need to be quoted
      // inside the select param, then the whole thing URL-encoded.
      const memberFields = [
        ...REPORT_COLUMNS.filter((c) => c.source === "member").map(
          (c) => c.key
        ),
        CLUB_LINK_FIELD,
      ]
        .map((k) => `"${k}"`)
        .join(",");
      const paidFields = REPORT_COLUMNS.filter((c) => c.source === "paid")
        .map((c) => `"${c.key}"`)
        .join(",");
      // Club No is now a real foreign key from memberT to ClubT, so
      // Supabase can embed the club name directly — no manual lookup.
      const selectParam = `${paidFields},memberT(${memberFields},ClubT(Club_Name))`;

      const authHeaders = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      };

      const [membersRes, clubsRes] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/PaidT?FKFYID=eq.${CURRENT_FY_ID}&select=${encodeURIComponent(
            selectParam
          )}`,
          { headers: authHeaders }
        ),
        // Fetched separately so the dropdown lists every club, not
        // just ones with current-FY members.
        fetch(
          `${SUPABASE_URL}/rest/v1/ClubT?select=${encodeURIComponent(
            `"Club No","Club_Name"`
          )}&order=Club_Name.asc`,
          { headers: authHeaders }
        ),
      ]);

      if (!membersRes.ok) {
        const data = await membersRes.json().catch(() => ({}));
        throw new Error(data.message || "Could not load the report");
      }
      const data = await membersRes.json();

      if (clubsRes.ok) {
        setClubs(await clubsRes.json());
      }

      // Each PaidT row carries a nested memberT record, which itself
      // carries a nested ClubT record. Flatten it all together, and
      // dedupe in case a member has more than one payment this FY.
      const byId = new Map();
      for (const row of data) {
        const { memberT, ...paidRest } = row;
        if (!memberT) continue;
        const { ClubT: club, ...memberRest } = memberT;
        const merged = {
          ...memberRest,
          ...paidRest,
          ClubName: club?.Club_Name || "—",
        };
        if (!byId.has(merged.MEMID)) {
          byId.set(merged.MEMID, merged);
        }
      }
      const sorted = [...byId.values()].sort((a, b) => {
        if (a.MEMID < b.MEMID) return -1;
        if (a.MEMID > b.MEMID) return 1;
        return 0;
      });
      setMembers(sorted);
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportLoading(false);
    }
  }

  function handleSignOut() {
    setSession(null);
    setMembers(null);
    setClubs([]);
    setSelectedClub("all");
    setNameSearch("");
    setView("landing");
    setEmail("");
    setPassword("");
  }

  const displayedMembers = members
    ? members.filter((m) => {
        const matchesClub =
          selectedClub === "all" ||
          String(m[CLUB_LINK_FIELD]) === String(selectedClub);
        const query = nameSearch.trim().toLowerCase();
        const matchesName =
          !query ||
          `${m["Given Name"] || ""} ${m["Surname"] || ""}`
            .toLowerCase()
            .includes(query);
        return matchesClub && matchesName;
      })
    : null;

  return (
    <div className="portal-root">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
      />
      <style>{`
        .portal-root {
          --paper: #f6f3ec;
          --paper-raised: #fffdf8;
          --ink: #1e2a38;
          --ink-muted: #5b6b7a;
          --rule: #d8d2c4;
          --forest: #35573f;
          --forest-tint: #e7ede8;
          --gold: #96731a;
          --danger: #8b3a3a;
          --danger-tint: #f3e6e6;
          font-family: 'IBM Plex Sans', sans-serif;
          color: var(--ink);
          background: var(--paper);
          min-height: 100%;
          width: 100%;
          box-sizing: border-box;
          padding: 40px 20px;
          display: flex;
          justify-content: center;
        }
        .portal-root * { box-sizing: border-box; }

        .signin-card {
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 40px 36px;
          width: 100%;
          max-width: 360px;
          height: fit-content;
          margin-top: 60px;
        }
        .signin-eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--ink-muted);
          margin: 0 0 6px 0;
        }
        .signin-title {
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 28px;
          margin: 0 0 28px 0;
          line-height: 1.15;
        }
        .field-label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: var(--ink-muted);
          margin-bottom: 6px;
        }
        .field {
          width: 100%;
          padding: 10px 12px;
          border: 1px solid var(--rule);
          border-radius: 3px;
          background: var(--paper);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          color: var(--ink);
          margin-bottom: 18px;
        }
        .field:focus {
          outline: 2px solid var(--forest);
          outline-offset: 1px;
        }
        .submit-btn {
          width: 100%;
          padding: 11px 12px;
          background: var(--ink);
          color: var(--paper-raised);
          border: none;
          border-radius: 3px;
          font-family: 'IBM Plex Sans', sans-serif;
          font-weight: 600;
          font-size: 14px;
          cursor: pointer;
        }
        .submit-btn:disabled {
          opacity: 0.55;
          cursor: default;
        }
        .submit-btn:focus-visible {
          outline: 2px solid var(--forest);
          outline-offset: 2px;
        }
        .auth-error {
          margin-top: 14px;
          padding: 10px 12px;
          background: var(--danger-tint);
          color: var(--danger);
          border-radius: 3px;
          font-size: 13px;
        }

        .dash {
          width: 100%;
          max-width: 900px;
        }
        .dash-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 14px;
          padding-bottom: 20px;
          margin-bottom: 24px;
          border-bottom: 2px solid var(--ink);
        }
        .dash-title-group { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .dash-title {
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 26px;
          margin: 0;
        }
        .fy-stamp {
          display: inline-block;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.1em;
          color: var(--forest);
          border: 1.5px solid var(--forest);
          border-radius: 2px;
          padding: 3px 9px;
          transform: rotate(-2deg);
        }
        .signout-btn {
          background: none;
          border: 1px solid var(--rule);
          border-radius: 3px;
          padding: 8px 14px;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 13px;
          color: var(--ink-muted);
          cursor: pointer;
        }
        .signout-btn:hover { border-color: var(--ink-muted); color: var(--ink); }

        .report-meta {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: var(--ink-muted);
          margin-bottom: 14px;
        }

        .filter-row {
          display: flex;
          align-items: flex-end;
          gap: 20px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .filter-row .field-label {
          margin-bottom: 6px;
          display: block;
        }
        .club-select {
          padding: 8px 12px;
          border: 1px solid var(--rule);
          border-radius: 3px;
          background: var(--paper-raised);
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 13.5px;
          color: var(--ink);
          min-width: 200px;
        }
        .club-select:focus {
          outline: 2px solid var(--forest);
          outline-offset: 1px;
        }

        .table-wrap {
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow-x: auto;
        }
        table { width: 100%; border-collapse: collapse; }
        th {
          text-align: left;
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-muted);
          padding: 12px 16px;
          border-bottom: 1.5px solid var(--rule);
          white-space: nowrap;
        }
        td {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13.5px;
          padding: 11px 16px;
          border-bottom: 1px solid var(--rule);
          white-space: nowrap;
        }
        tbody tr:nth-child(odd) { background: rgba(53, 87, 63, 0.035); }
        tbody tr:last-child td { border-bottom: none; }

        .empty-state, .loading-state {
          padding: 40px 16px;
          text-align: center;
          color: var(--ink-muted);
          font-size: 14px;
        }
        .report-error {
          padding: 16px;
          background: var(--danger-tint);
          color: var(--danger);
          border-radius: 4px;
          font-size: 13px;
        }

        .landing {
          width: 100%;
          max-width: 640px;
          margin-top: 30px;
        }
        .landing-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 18px;
        }
        .landing-title {
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 30px;
          margin: 0 0 28px 0;
        }
        .tool-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 16px;
        }
        .tool-card {
          text-align: left;
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 22px 20px;
          cursor: pointer;
          font-family: inherit;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .tool-card:hover:not(.tool-card-disabled) {
          border-color: var(--forest);
        }
        .tool-card:focus-visible {
          outline: 2px solid var(--forest);
          outline-offset: 2px;
        }
        .tool-card-disabled {
          cursor: default;
          opacity: 0.55;
        }
        .tool-card-title {
          font-family: 'Fraunces', serif;
          font-weight: 600;
          font-size: 18px;
          color: var(--ink);
        }
        .tool-card-desc {
          font-size: 13px;
          color: var(--ink-muted);
        }

        .back-btn {
          background: none;
          border: none;
          color: var(--ink-muted);
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 13px;
          cursor: pointer;
          padding: 0;
        }
        .back-btn:hover { color: var(--ink); }

        .search-input {
          padding: 8px 12px;
          border: 1px solid var(--rule);
          border-radius: 3px;
          background: var(--paper-raised);
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 13.5px;
          color: var(--ink);
          min-width: 220px;
        }
        .search-input:focus {
          outline: 2px solid var(--forest);
          outline-offset: 1px;
        }
      `}</style>

      {!session ? (
        <form className="signin-card" onSubmit={handleSignIn}>
          <p className="signin-eyebrow">Member Registry</p>
          <h1 className="signin-title">Sign in to view<br />the roster</h1>

          <label className="field-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="field"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label className="field-label" htmlFor="password">Password</label>
          <input
            id="password"
            className="field"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <button className="submit-btn" type="submit" disabled={authLoading}>
            {authLoading ? "Signing in…" : "Sign in"}
          </button>

          {authError && <div className="auth-error">{authError}</div>}
        </form>
      ) : view === "landing" ? (
        <div className="landing">
          <div className="landing-header">
            <p className="signin-eyebrow">Member Registry</p>
            <button className="signout-btn" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
          <h1 className="landing-title">What would you like to do?</h1>

          <div className="tool-grid">
            <button className="tool-card" onClick={openMemberLookup}>
              <span className="tool-card-title">Member Lookup</span>
              <span className="tool-card-desc">
                Search and filter the current fiscal year roster
              </span>
            </button>

            <div className="tool-card tool-card-disabled">
              <span className="tool-card-title">Practice Sign-In</span>
              <span className="tool-card-desc">Coming soon</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="dash">
          <div className="dash-header">
            <div className="dash-title-group">
              <button className="back-btn" onClick={() => setView("landing")}>
                ← Home
              </button>
              <h1 className="dash-title">Current Members</h1>
              <span className="fy-stamp">{CURRENT_FY_LABEL} · CURRENT</span>
            </div>
            <button className="signout-btn" onClick={handleSignOut}>
              Sign out
            </button>
          </div>

          {reportLoading && (
            <div className="loading-state">Loading roster…</div>
          )}

          {!reportLoading && reportError && (
            <div className="report-error">{reportError}</div>
          )}

          {!reportLoading && !reportError && members && (
            <>
              <div className="filter-row">
                <div>
                  <label className="field-label" htmlFor="club-filter">
                    Club
                  </label>
                  <select
                    id="club-filter"
                    className="club-select"
                    value={selectedClub}
                    onChange={(e) => setSelectedClub(e.target.value)}
                  >
                    <option value="all">All Clubs</option>
                    {clubs.map((c) => (
                      <option key={c["Club No"]} value={c["Club No"]}>
                        {c["Club_Name"]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="field-label" htmlFor="name-search">
                    Search by name
                  </label>
                  <input
                    id="name-search"
                    className="search-input"
                    type="text"
                    placeholder="Given name or surname…"
                    value={nameSearch}
                    onChange={(e) => setNameSearch(e.target.value)}
                  />
                </div>
              </div>

              <p className="report-meta">
                {displayedMembers.length} member
                {displayedMembers.length === 1 ? "" : "s"} on record for{" "}
                {CURRENT_FY_LABEL}
                {selectedClub !== "all" ? " in this club" : ""}
                {nameSearch.trim() ? ` matching “${nameSearch.trim()}”` : ""}
              </p>
              {displayedMembers.length === 0 ? (
                <div className="table-wrap">
                  <div className="empty-state">
                    No members match the current filters.
                  </div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {REPORT_COLUMNS.map((col) => (
                          <th key={col.key}>{col.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedMembers.map((row, i) => (
                        <tr key={i}>
                          {REPORT_COLUMNS.map((col) => (
                            <td key={col.key}>{String(row[col.key] ?? "—")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
