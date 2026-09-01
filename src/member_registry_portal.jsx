import { useState, useRef, useEffect } from "react";
import { Html5Qrcode } from "html5-qrcode";
import associationLogo from "./WASRA-logo-small-300x300.png";


// ---- Fill these in with your Supabase project details ----
const SUPABASE_URL = "https://ttxtxhqgkgihhscerdgf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aL49TtFkyRe0cL3u7cTIuQ_OVYs2qUk";
// -------------------------------------------------------------
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
  const [clubQuery, setClubQuery] = useState("");
  const [nameSearch, setNameSearch] = useState("");

  // "landing" = the home screen with tool buttons; "lookup" = the
  // member report; "signin" = the practice sign-in scanner.
  const [view, setView] = useState("landing");

  // --- Practice sign-in state ---
  const todayISO = new Date().toISOString().slice(0, 10);
  const [sessionDate, setSessionDate] = useState(todayISO);
  const [dateLocked, setDateLocked] = useState(false);
  const [signInLog, setSignInLog] = useState([]);
  const [signInLoading, setSignInLoading] = useState(false);
  const [scanInput, setScanInput] = useState("");
  const [scanStatus, setScanStatus] = useState(null); // { type: 'ok'|'warn'|'error', text }
  const scanInputRef = useRef(null);

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

  function openSignIn() {
    setView("signin");
    // The sign-in flag needs to know who's a current FY member, so
    // make sure that roster is loaded even if Member Lookup was
    // never opened this session.
    if (!members && session) {
      fetchReport(session.access_token);
    }
  }

  function authHeadersFor(accessToken) {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    };
  }

  async function lockSessionDate() {
    if (!sessionDate) return;
    setDateLocked(true);
    setSignInLoading(true);
    setScanStatus(null);
    try {
      // Load anyone already signed in today, in case this date's
      // session was started earlier (e.g. reopened after a refresh).
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/SignInT?SessionDate=eq.${sessionDate}&select=${encodeURIComponent(
          `SignInID,FKMemID,IsCurrentMember,CreatedAt,memberT(MEMID,"Given Name",Surname)`
        )}&order=CreatedAt.desc`,
        { headers: authHeadersFor(session.access_token) }
      );
      if (res.ok) {
        const data = await res.json();
        setSignInLog(
          data.map((row) => ({
            SignInID: row.SignInID,
            MEMID: row.memberT?.MEMID ?? row.FKMemID,
            GivenName: row.memberT?.["Given Name"] ?? "",
            Surname: row.memberT?.Surname ?? "",
            IsCurrentMember: row.IsCurrentMember,
            CreatedAt: row.CreatedAt,
          }))
        );
      }
    } finally {
      setSignInLoading(false);
      setTimeout(() => scanInputRef.current?.focus(), 0);
    }
  }

  function changeSessionDate() {
    setDateLocked(false);
    setSignInLog([]);
    setScanStatus(null);
  }

  // Card numbers printed/encoded on membership cards are always the
  // real MEMID plus this offset.
  const CARD_NUMBER_OFFSET = 60000;

  // Shared by both the manual/hardware-scanner text field and the
  // camera scanner. Looks up the card number, records the sign-in,
  // and updates the on-screen log.
  async function processScan(raw) {
    if (!raw) return;

    const cardNumber = Number(raw);
    if (!Number.isFinite(cardNumber)) {
      setScanStatus({ type: "error", text: `"${raw}" isn't a valid card number.` });
      return;
    }
    const memId = cardNumber - CARD_NUMBER_OFFSET;

    // Already logged for today — don't double up.
    if (signInLog.some((entry) => String(entry.MEMID) === String(memId))) {
      setScanStatus({ type: "warn", text: `Member ${memId} is already signed in today.` });
      return;
    }

    try {
      const headers = authHeadersFor(session.access_token);

      const lookupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/memberT?MEMID=eq.${memId}&select=${encodeURIComponent(
          `MEMID,"Given Name",Surname`
        )}`,
        { headers }
      );
      if (!lookupRes.ok) throw new Error("Could not look up that member ID.");
      const found = await lookupRes.json();

      if (found.length === 0) {
        setScanStatus({ type: "error", text: `No member found for card ${raw}.` });
        return;
      }

      const member = found[0];
      const isCurrent = (members || []).some(
        (m) => String(m.MEMID) === String(member.MEMID)
      );

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/SignInT`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          FKMemID: member.MEMID,
          SessionDate: sessionDate,
          IsCurrentMember: isCurrent,
        }),
      });
      if (!insertRes.ok) {
        const errData = await insertRes.json().catch(() => ({}));
        throw new Error(errData.message || "Could not record the sign-in.");
      }
      const [inserted] = await insertRes.json();

      setSignInLog((prev) => [
        {
          SignInID: inserted.SignInID,
          MEMID: member.MEMID,
          GivenName: member["Given Name"],
          Surname: member.Surname,
          IsCurrentMember: isCurrent,
          CreatedAt: inserted.CreatedAt,
        },
        ...prev,
      ]);
      setScanStatus(
        isCurrent
          ? { type: "ok", text: `Signed in: ${member["Given Name"]} ${member.Surname}` }
          : {
              type: "warn",
              text: `Signed in: ${member["Given Name"]} ${member.Surname} — NOT a current FY member`,
            }
      );
    } catch (err) {
      setScanStatus({ type: "error", text: err.message });
    }
  }

  async function handleScanSubmit(e) {
    e.preventDefault();
    const raw = scanInput.trim();
    setScanInput("");
    await processScan(raw);
    scanInputRef.current?.focus();
  }

  // --- Camera scanning ---
  const [cameraOn, setCameraOn] = useState(false);
  const html5QrCodeRef = useRef(null);
  const cameraBusyRef = useRef(false);

  async function startCamera() {
    setCameraOn(true);
    setScanStatus(null);
    try {
      const instance = new Html5Qrcode("qr-camera-region");
      html5QrCodeRef.current = instance;

      // Don't call Html5Qrcode.getCameras() on iOS Safari — until camera
      // permission is actually granted it can return a device with a
      // missing/malformed `id`, and passing that into start() is what
      // triggers the "facingMode should be string or object with exact
      // as key" error. A facingMode constraint skips enumeration
      // entirely and works reliably on iOS/Android/desktop.
      await instance.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 240 },
        async (decodedText) => {
          // Ignore rapid repeat callbacks while a scan is being
          // processed, so the same card doesn't fire twice.
          if (cameraBusyRef.current) return;
          cameraBusyRef.current = true;
          await processScan(decodedText.trim());
          setTimeout(() => {
            cameraBusyRef.current = false;
          }, 1500);
        },
        () => {
          /* ignore per-frame "no QR found" callbacks */
        }
      );
    } catch (err) {
      console.error("CAMERA ERROR:", err);

      setScanStatus({
        type: "error",
        text: err?.message || String(err),
      });

      setCameraOn(false);
    }
  }

  async function stopCamera() {
    const instance = html5QrCodeRef.current;
    if (instance) {
      try {
        await instance.stop();
        instance.clear();
      } catch {
        // camera may already be stopped — safe to ignore
      }
      html5QrCodeRef.current = null;
    }
    setCameraOn(false);
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
        // Fetched separately so the dropdown lists every incorporated
        // club, not just ones with current-FY members.
        fetch(
          `${SUPABASE_URL}/rest/v1/ClubT?select=${encodeURIComponent(
            `"CLUBID","Club_Name"`
          )}&Incorporated=eq.true&order=Club_Name.asc`,
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
    if (cameraOn) stopCamera();
    setSession(null);
    setMembers(null);
    setClubs([]);
    setSelectedClub("all");
    setClubQuery("");
    setNameSearch("");
    setView("landing");
    setEmail("");
    setPassword("");
    setSessionDate(todayISO);
    setDateLocked(false);
    setSignInLog([]);
    setScanInput("");
    setScanStatus(null);
  }

  const displayedMembers = members
    ? members.filter((m) => {
        const matchesClub =
          selectedClub === "all"
            ? true
            : selectedClub === "none"
            ? false
            : String(m[CLUB_LINK_FIELD]) === String(selectedClub);
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

        .table-wrap {
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          overflow-x: auto;
        }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th {
          text-align: left;
          font-size: 11px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--ink-muted);
          padding: 12px 16px;
          border-bottom: 1.5px solid var(--rule);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        td {
          text-align: left;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13.5px;
          padding: 11px 16px;
          border-bottom: 1px solid var(--rule);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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

        .club-field-wrap {
          position: relative;
          display: inline-block;
        }
        .club-field-wrap .search-input {
          padding-right: 30px;
        }
        .clear-btn {
          position: absolute;
          right: 6px;
          top: 50%;
          transform: translateY(-50%);
          background: none;
          border: none;
          color: var(--ink-muted);
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 4px 6px;
        }
        .clear-btn:hover { color: var(--ink); }

        .date-lock-card {
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 28px;
          max-width: 320px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .date-lock-btn { margin-top: 6px; }

        .session-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 18px;
          padding-bottom: 14px;
          border-bottom: 1px solid var(--rule);
        }
        .session-date-label {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 13px;
          color: var(--ink-muted);
        }

        .scan-row {
          margin-bottom: 14px;
          display: flex;
          gap: 10px;
          align-items: stretch;
        }
        .scan-input {
          flex: 1;
          font-size: 16px;
          padding: 14px 16px;
        }
        .camera-toggle-btn {
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 3px;
          padding: 0 16px;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 13.5px;
          color: var(--ink);
          cursor: pointer;
          white-space: nowrap;
        }
        .camera-toggle-btn:hover { border-color: var(--forest); }

        .camera-wrap {
          margin-bottom: 16px;
          background: var(--paper-raised);
          border: 1px solid var(--rule);
          border-radius: 4px;
          padding: 16px;
          max-width: 420px;
        }
        .camera-wrap-hidden {
          display: none;
        }
        #qr-camera-region {
          width: 100%;
          border-radius: 3px;
          overflow: hidden;
        }
        .camera-hint {
          margin: 10px 0 0 0;
          font-size: 12px;
          color: var(--ink-muted);
          text-align: center;
        }

        .scan-status {
          padding: 10px 14px;
          border-radius: 3px;
          font-size: 13.5px;
          margin-bottom: 16px;
        }
        .scan-status-ok {
          background: var(--forest-tint);
          color: var(--forest);
        }
        .scan-status-warn {
          background: #fbf0dd;
          color: var(--gold);
        }
        .scan-status-error {
          background: var(--danger-tint);
          color: var(--danger);
        }

        tr.row-flagged { background: #fbeaea; }
        .flag-badge {
          display: inline-block;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          letter-spacing: 0.03em;
          color: var(--danger);
          border: 1px solid var(--danger);
          border-radius: 2px;
          padding: 2px 6px;
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

            <button className="tool-card" onClick={openSignIn}>
              <span className="tool-card-title">Practice Sign-In</span>
              <span className="tool-card-desc">
                Scan or enter member IDs to log today's session
              </span>
            </button>
          </div>
        </div>
      ) : view === "lookup" ? (
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
                  <div className="club-field-wrap">
                    <input
                      id="club-filter"
                      className="search-input"
                      type="text"
                      list="club-options"
                      placeholder="All Clubs"
                      value={clubQuery}
                      onChange={(e) => {
                        const typed = e.target.value;
                        setClubQuery(typed);
                        if (typed.trim() === "") {
                          setSelectedClub("all");
                          return;
                        }
                        const match = clubs.find(
                          (c) =>
                            c.Club_Name.toLowerCase() === typed.toLowerCase()
                        );
                        setSelectedClub(match ? match["CLUBID"] : "none");
                      }}
                    />
                    {clubQuery && (
                      <button
                        type="button"
                        className="clear-btn"
                        aria-label="Clear club filter"
                        onClick={() => {
                          setClubQuery("");
                          setSelectedClub("all");
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <datalist id="club-options">
                    {clubs.map((c) => (
                      <option key={c["CLUBID"]} value={c["Club_Name"]} />
                    ))}
                  </datalist>
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
      ) : (
        <div className="dash">
          <div className="dash-header">
            <div className="dash-title-group">
              <button
                className="back-btn"
                onClick={() => {
                  if (cameraOn) stopCamera();
                  setView("landing");
                }}
              >
                ← Home
              </button>
              <h1 className="dash-title">Practice Sign-In</h1>
            </div>
            <button className="signout-btn" onClick={handleSignOut}>
              Sign out
            </button>
          </div>

          {!dateLocked ? (
            <form
              className="date-lock-card"
              onSubmit={(e) => {
                e.preventDefault();
                lockSessionDate();
              }}
            >
              <label className="field-label" htmlFor="session-date">
                Session date
              </label>
              <input
                id="session-date"
                className="search-input"
                type="date"
                value={sessionDate}
                onChange={(e) => setSessionDate(e.target.value)}
                required
              />
              <button className="submit-btn date-lock-btn" type="submit">
                Start session
              </button>
            </form>
          ) : (
            <>
              <div className="session-bar">
                <span className="session-date-label">
                  Session date: <strong>{sessionDate}</strong>
                </span>
                <button className="back-btn" onClick={changeSessionDate}>
                  Change date
                </button>
              </div>

              <form className="scan-row" onSubmit={handleScanSubmit}>
                <input
                  ref={scanInputRef}
                  className="search-input scan-input"
                  type="text"
                  placeholder="Scan card or type card number, then press Enter"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  className="camera-toggle-btn"
                  onClick={cameraOn ? stopCamera : startCamera}
                >
                  {cameraOn ? "Stop Camera" : "Use Camera Instead"}
                </button>
              </form>

              <div className={`camera-wrap ${cameraOn ? "" : "camera-wrap-hidden"}`}>
                <div id="qr-camera-region" />
                <p className="camera-hint">
                  Point the camera at the QR code on the membership card.
                </p>
              </div>

              {scanStatus && (
                <div className={`scan-status scan-status-${scanStatus.type}`}>
                  {scanStatus.text}
                </div>
              )}

              {signInLoading ? (
                <div className="loading-state">Loading today's sign-ins…</div>
              ) : (
                <>
                  <p className="report-meta">
                    {signInLog.length} signed in today
                    {signInLog.some((e) => !e.IsCurrentMember)
                      ? ` — ${signInLog.filter((e) => !e.IsCurrentMember).length} not current, needs review`
                      : ""}
                  </p>
                  {signInLog.length === 0 ? (
                    <div className="table-wrap">
                      <div className="empty-state">
                        No one has signed in yet — scan a card to begin.
                      </div>
                    </div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Member ID</th>
                            <th>Given Name</th>
                            <th>Surname</th>
                            <th>Status</th>
                            <th>Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {signInLog.map((entry) => (
                            <tr
                              key={entry.SignInID}
                              className={
                                entry.IsCurrentMember ? "" : "row-flagged"
                              }
                            >
                              <td>{entry.MEMID}</td>
                              <td>{entry.GivenName || "—"}</td>
                              <td>{entry.Surname || "—"}</td>
                              <td>
                                {entry.IsCurrentMember ? (
                                  "Current"
                                ) : (
                                  <span className="flag-badge">
                                    Review — not current
                                  </span>
                                )}
                              </td>
                              <td>
                                {entry.CreatedAt
                                  ? new Date(
                                      entry.CreatedAt
                                    ).toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
