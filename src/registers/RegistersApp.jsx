import { useCallback, useEffect, useMemo, useState } from "react";
import { createApi, formatDate, todayLocal } from "./api";
import associationLogo from "../WASRA-logo-small-300x300.png";
import "./registers.css";

const CONFIG = {
  lockers: {
    title: "Locker Register",
    singular: "locker",
    plural: "lockers",
    registerView: "app_locker_register",
    historyView: "app_locker_history",
    groupLabel: "Location",
    numberLabel: "Locker number",
    issueVerb: "Assign",
    assignedWord: "Assigned",
  },
  keys: {
    title: "Key Register",
    singular: "key",
    plural: "keys",
    registerView: "app_key_register",
    historyView: "app_key_history",
    groupLabel: "Key type",
    numberLabel: "Key number",
    issueVerb: "Issue",
    assignedWord: "Issued",
  },
};

const CATEGORIES = [
  "Lighting",
  "Plumbing",
  "Electrical",
  "Building",
  "Grounds",
  "Range equipment",
  "Security",
  "Other",
];
const POSITIONS = ["President", "Treasurer", "Nominated contact"];
const STATUS_LABEL = { open: "Open", in_progress: "In progress", resolved: "Resolved" };

function Header({ title, onHome, onSignOut }) {
  return (
    <div className="dash-header">
      <div className="dash-title-group">
        <img className="logo-small" src={associationLogo} alt="WA Small Bore Rifle Association" />
        <button className="back-btn" onClick={onHome}>
          ← Home
        </button>
        <h1 className="dash-title">{title}</h1>
      </div>
      <button className="signout-btn" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

function Notice({ message, error }) {
  if (message) return <div className="scan-status scan-status-ok">{message}</div>;
  if (error) return <div className="scan-status scan-status-error">{error}</div>;
  return null;
}

function NoAccess({ what }) {
  return (
    <div className="report-error">
      You do not have access to {what}. Ask an administrator to grant it.
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lockers and keys                                                     */
/* ------------------------------------------------------------------ */
function RegisterScreen({ kind, api, level, onHome, onSignOut }) {
  const cfg = CONFIG[kind];
  const isKeys = kind === "keys";
  const canEdit = level === "edit";

  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [panel, setPanel] = useState(null); // { itemId, mode }
  const [history, setHistory] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [newNumber, setNewNumber] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const [wasra, setWasra] = useState("");
  const [holderName, setHolderName] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [deposit, setDeposit] = useState("");
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.select(
        `${cfg.registerView}?select=*&order=item_group.asc.nullslast,item_number.asc`
      );
      setRows(data || []);
    } catch (err) {
      setError(err.message);
      setRows([]);
    }
  }, [api, cfg.registerView]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const active = (rows || []).filter((r) => r.is_active);
    const assigned = active.filter((r) => r.assignment_id !== null).length;
    return { total: active.length, assigned, available: active.length - assigned };
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || [])
      .filter((r) => {
        if (filter === "inactive") return !r.is_active;
        if (!r.is_active) return false;
        if (filter === "assigned") return r.assignment_id !== null;
        if (filter === "available") return r.assignment_id === null;
        return true;
      })
      .filter(
        (r) =>
          !q ||
          [r.item_number, r.item_group, r.holder_name, r.wasra_number]
            .filter((v) => v !== null && v !== undefined && v !== "")
            .some((v) => String(v).toLowerCase().includes(q))
      );
  }, [rows, query, filter]);

  function resetForm() {
    setWasra("");
    setHolderName("");
    setDate(todayLocal());
    setDeposit("");
    setCondition("");
    setNotes("");
  }

  async function openPanel(next) {
    setMessage("");
    setError("");
    resetForm();
    setHistory([]);
    setPanel(next);
    if (next && next.mode === "history") {
      try {
        const data = await api.select(
          `${cfg.historyView}?select=*&item_id=eq.${next.itemId}&order=assigned_on.desc,assignment_id.desc`
        );
        setHistory(data || []);
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function addItem(e) {
    e.preventDefault();
    setMessage("");
    setError("");
    const number = newNumber.trim();
    if (!number) return setError(`${cfg.numberLabel} is required.`);
    if (isKeys && !newGroup.trim()) return setError("Key type is required.");

    setBusy(true);
    try {
      if (isKeys) {
        await api.insert("register_keys", {
          key_number: number,
          key_type: newGroup.trim(),
          description: newNotes.trim() || null,
        });
      } else {
        await api.insert("lockers", {
          locker_number: number,
          location: newGroup.trim() || null,
          notes: newNotes.trim() || null,
        });
      }
      setMessage(`${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} ${number} added.`);
      setNewNumber("");
      setNewNotes("");
      await load();
    } catch (err) {
      setError(err.code === "23505" ? `That ${cfg.singular} already exists.` : err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setItemActive(row, active) {
    setMessage("");
    setError("");
    setBusy(true);
    try {
      await api.update(isKeys ? "register_keys" : "lockers", `id=eq.${row.item_id}`, {
        is_active: active,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function finish(result, success) {
    if (!result || result.outcome !== success) {
      setError((result && result.message) || "Unexpected response.");
      return;
    }
    setMessage(result.message);
    setPanel(null);
    load();
  }

  async function submitAssign(e, row) {
    e.preventDefault();
    setMessage("");
    setError("");
    const wasraNumber = wasra.trim() ? Number(wasra.trim()) : null;
    if (wasraNumber !== null && (!Number.isInteger(wasraNumber) || wasraNumber <= 0)) {
      return setError("WASRA number must be a whole number.");
    }
    if (wasraNumber === null && !holderName.trim()) {
      return setError("Enter a WASRA number or a holder name.");
    }
    const depositAmount = deposit.trim() ? Number(deposit.trim()) : null;
    if (depositAmount !== null && (!Number.isFinite(depositAmount) || depositAmount < 0)) {
      return setError("Deposit must be a positive amount.");
    }

    setBusy(true);
    try {
      const result = isKeys
        ? await api.rpc("assign_key", {
            p_key_id: row.item_id,
            p_wasra_number: wasraNumber,
            p_holder_name: holderName.trim() || null,
            p_assigned_on: date || null,
            p_deposit_amount: depositAmount,
            p_condition: condition.trim() || null,
            p_notes: notes.trim() || null,
          })
        : await api.rpc("assign_locker", {
            p_locker_id: row.item_id,
            p_wasra_number: wasraNumber,
            p_holder_name: holderName.trim() || null,
            p_assigned_on: date || null,
            p_notes: notes.trim() || null,
          });
      finish(result, "assigned");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReturn(e, row) {
    e.preventDefault();
    setMessage("");
    setError("");
    setBusy(true);
    try {
      const result = isKeys
        ? await api.rpc("return_key", {
            p_key_id: row.item_id,
            p_returned_on: date || null,
            p_condition: condition.trim() || null,
            p_notes: notes.trim() || null,
          })
        : await api.rpc("return_locker", {
            p_locker_id: row.item_id,
            p_returned_on: date || null,
            p_notes: notes.trim() || null,
          });
      finish(result, "returned");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const filters = [
    ["all", "All"],
    ["assigned", cfg.assignedWord],
    ["available", "Available"],
    ["inactive", "Inactive"],
  ];

  return (
    <div className="reg-wrap">
      <Header title={cfg.title} onHome={onHome} onSignOut={onSignOut} />

      {level === "none" ? (
        <NoAccess what={`the ${cfg.singular} register`} />
      ) : rows === null ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <>
          <div className="reg-stats">
            <div className="reg-stat">
              <b>{stats.total}</b>
              <span>TOTAL</span>
            </div>
            <div className="reg-stat">
              <b>{stats.assigned}</b>
              <span>{cfg.assignedWord.toUpperCase()}</span>
            </div>
            <div className="reg-stat">
              <b>{stats.available}</b>
              <span>AVAILABLE</span>
            </div>
          </div>

          {!canEdit && <p className="reg-hint">View only. You cannot change this register.</p>}
          <Notice message={message} error={error} />

          <input
            className="field"
            placeholder={`Search ${cfg.plural}, holder or WASRA number`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="reg-toolbar">
            {filters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`reg-btn ${filter === value ? "on" : ""}`}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
            {canEdit && (
              <button type="button" className="reg-btn" onClick={() => setShowAdd((v) => !v)}>
                {showAdd ? "Cancel" : `Add ${cfg.singular}`}
              </button>
            )}
          </div>

          {canEdit && showAdd && (
            <form className="reg-panel" onSubmit={addItem}>
              <label className="field-label">{cfg.numberLabel}</label>
              <input className="field" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} />
              <label className="field-label">{cfg.groupLabel}</label>
              <input className="field" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
              <label className="field-label">
                {isKeys ? "Description" : "Notes"} (optional)
              </label>
              <input className="field" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
              <button className="submit-btn" disabled={busy} type="submit">
                Save {cfg.singular}
              </button>
            </form>
          )}

          <p className="report-meta">
            {visible.length} {visible.length === 1 ? cfg.singular : cfg.plural}
          </p>

          {visible.length === 0 && <div className="empty-state">No {cfg.plural} to show.</div>}

          {visible.map((row) => {
            const assigned = row.assignment_id !== null;
            const open = panel && panel.itemId === row.item_id ? panel.mode : null;
            const label = isKeys
              ? `${row.item_group || ""} ${row.item_number}`.trim()
              : `Locker ${row.item_number}`;

            return (
              <div className="reg-item" key={row.item_id}>
                <div className="reg-item-row">
                  <div>
                    <div className="reg-name">{label}</div>
                    <div className="reg-meta">
                      {!isKeys && row.item_group ? `${row.item_group} · ` : ""}
                      {assigned
                        ? `${row.holder_name || "Unknown"}${row.wasra_number ? ` (WASRA ${row.wasra_number})` : ""} · since ${formatDate(row.assigned_on)}`
                        : row.is_active
                          ? "Available"
                          : "Inactive"}
                    </div>
                    {assigned && isKeys && (row.deposit_amount !== null || row.condition) && (
                      <div className="reg-meta">
                        {row.deposit_amount !== null
                          ? `Deposit $${Number(row.deposit_amount).toFixed(2)}`
                          : ""}
                        {row.deposit_amount !== null && row.condition ? " · " : ""}
                        {row.condition ? `Condition: ${row.condition}` : ""}
                      </div>
                    )}
                    {row.item_notes && <div className="reg-meta">{row.item_notes}</div>}
                  </div>
                  <span className={`reg-tag ${assigned ? "warn" : row.is_active ? "good" : ""}`}>
                    {assigned ? cfg.assignedWord.toUpperCase() : row.is_active ? "AVAILABLE" : "INACTIVE"}
                  </span>
                </div>

                <div className="reg-actions">
                  {canEdit && row.is_active && !assigned && (
                    <button
                      type="button"
                      className="reg-btn primary"
                      onClick={() => openPanel(open === "assign" ? null : { itemId: row.item_id, mode: "assign" })}
                    >
                      {cfg.issueVerb}
                    </button>
                  )}
                  {canEdit && assigned && (
                    <button
                      type="button"
                      className="reg-btn"
                      onClick={() => openPanel(open === "return" ? null : { itemId: row.item_id, mode: "return" })}
                    >
                      Return
                    </button>
                  )}
                  <button
                    type="button"
                    className="reg-btn"
                    onClick={() => openPanel(open === "history" ? null : { itemId: row.item_id, mode: "history" })}
                  >
                    History
                  </button>
                </div>

                {open === "assign" && (
                  <form className="reg-panel" onSubmit={(e) => submitAssign(e, row)}>
                    <label className="field-label">WASRA number</label>
                    <input
                      className="field"
                      inputMode="numeric"
                      value={wasra}
                      onChange={(e) => setWasra(e.target.value)}
                      autoFocus
                    />
                    <label className="field-label">Or holder name (non-member)</label>
                    <input className="field" value={holderName} onChange={(e) => setHolderName(e.target.value)} />
                    <label className="field-label">{isKeys ? "Issue date" : "Assigned date"}</label>
                    <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                    {isKeys && (
                      <>
                        <label className="field-label">Deposit paid ($, optional)</label>
                        <input
                          className="field"
                          inputMode="decimal"
                          value={deposit}
                          onChange={(e) => setDeposit(e.target.value)}
                        />
                        <label className="field-label">Condition (optional)</label>
                        <input className="field" value={condition} onChange={(e) => setCondition(e.target.value)} />
                      </>
                    )}
                    <label className="field-label">Notes (optional)</label>
                    <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <button className="submit-btn" disabled={busy} type="submit">
                      {cfg.issueVerb} {cfg.singular}
                    </button>
                  </form>
                )}

                {open === "return" && (
                  <form className="reg-panel" onSubmit={(e) => submitReturn(e, row)}>
                    <label className="field-label">Return date</label>
                    <input className="field" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                    {isKeys && (
                      <>
                        <label className="field-label">Condition on return (optional)</label>
                        <input className="field" value={condition} onChange={(e) => setCondition(e.target.value)} />
                      </>
                    )}
                    <label className="field-label">Notes (optional)</label>
                    <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <button className="submit-btn" disabled={busy} type="submit">
                      Confirm return
                    </button>
                  </form>
                )}

                {open === "history" && (
                  <div className="reg-panel">
                    {history.length === 0 && <div className="reg-meta">No assignments recorded.</div>}
                    {history.map((h) => (
                      <div className="reg-meta" key={h.assignment_id} style={{ marginBottom: 8 }}>
                        <strong>{h.holder_name || "Unknown"}</strong>
                        {h.wasra_number ? ` (WASRA ${h.wasra_number})` : ""} · {formatDate(h.assigned_on)} to{" "}
                        {h.returned_on ? formatDate(h.returned_on) : "present"}
                        {h.deposit_amount !== null ? ` · Deposit $${Number(h.deposit_amount).toFixed(2)}` : ""}
                        {h.condition ? ` · ${h.condition}` : ""}
                        {h.notes ? ` · ${h.notes}` : ""}
                      </div>
                    ))}
                    {canEdit && (
                      <div className="reg-actions">
                        <button
                          type="button"
                          className="reg-btn danger"
                          disabled={busy || assigned}
                          onClick={() => setItemActive(row, !row.is_active)}
                        >
                          {row.is_active ? `Retire ${cfg.singular}` : `Reactivate ${cfg.singular}`}
                        </button>
                      </div>
                    )}
                    {canEdit && assigned && <div className="reg-meta">Return it before retiring.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Venue issues                                                         */
/* ------------------------------------------------------------------ */
function whenText(value) {
  return new Date(value).toLocaleString("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Phone photos are often 4-10 MB; shrink before upload.
async function shrinkImage(file, maxEdge = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to process the photo.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Unable to process the photo."))),
      "image/jpeg",
      quality
    )
  );
}

function IssuesScreen({ api, level, onHome, onSignOut }) {
  const canEdit = level === "edit";
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("active");
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [photoUrls, setPhotoUrls] = useState({});

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [location, setLocation] = useState("");
  const [priority, setPriority] = useState("normal");
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState("");
  const [resolveNotes, setResolveNotes] = useState({});

  const load = useCallback(async () => {
    try {
      const data =
        (await api.select("app_venue_issues?select=*&order=created_at.desc")) || [];
      setRows(data);
      const paths = data.filter((i) => i.photo_path).map((i) => i.photo_path);
      setPhotoUrls(await api.signedPhotoUrls(paths));
    } catch (err) {
      setError(err.message);
      setRows((current) => current || []);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!photo) {
      setPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const visible = (rows || []).filter((r) =>
    filter === "all" ? true : filter === "resolved" ? r.status === "resolved" : r.status !== "resolved"
  );

  async function submit(e) {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!title.trim()) return setError("Enter a short title for the issue.");

    setBusy(true);
    try {
      let photoPath = null;
      if (photo) {
        const blob = await shrinkImage(photo);
        const path = `${new Date().getFullYear()}/${crypto.randomUUID()}.jpg`;
        await api.uploadPhoto(path, blob);
        photoPath = path;
      }
      await api.insert("venue_issues", {
        title: title.trim(),
        description: description.trim() || null,
        category,
        location: location.trim() || null,
        priority,
        photo_path: photoPath,
      });
      setMessage("Issue reported.");
      setTitle("");
      setDescription("");
      setLocation("");
      setPriority("normal");
      setPhoto(null);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err.message || "Unable to report the issue.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(issue, status) {
    setMessage("");
    setError("");
    setBusy(true);
    try {
      const resolved = status === "resolved";
      await api.update("venue_issues", `id=eq.${issue.id}`, {
        status,
        resolved_at: resolved ? new Date().toISOString() : null,
        resolution_notes: resolved ? (resolveNotes[issue.id] || "").trim() || null : null,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reg-wrap">
      <Header title="Notifications" onHome={onHome} onSignOut={onSignOut} />

      {level === "none" ? (
        <NoAccess what="notifications" />
      ) : rows === null ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <>
          {!canEdit && <p className="reg-hint">View only. You cannot report or update issues.</p>}
          <Notice message={message} error={error} />

          <div className="reg-toolbar">
            {[
              ["active", "Active"],
              ["resolved", "Resolved"],
              ["all", "All"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`reg-btn ${filter === value ? "on" : ""}`}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
            {canEdit && (
              <button type="button" className="reg-btn primary" onClick={() => setShowForm((v) => !v)}>
                {showForm ? "Cancel" : "Report issue"}
              </button>
            )}
          </div>

          {canEdit && showForm && (
            <form className="reg-panel" onSubmit={submit}>
              <label className="field-label">What is the issue?</label>
              <input
                className="field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Leaking tap in toilets"
              />
              <label className="field-label">Category</label>
              <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <label className="field-label">Where at the venue (optional)</label>
              <input
                className="field"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Clubhouse kitchen"
              />
              <label className="field-label">Priority</label>
              <select className="field" value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="urgent">Urgent</option>
              </select>
              <label className="field-label">Details (optional)</label>
              <textarea
                className="field"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <label className="field-label">Photo (optional)</label>
              <input
                className="field"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhoto((e.target.files && e.target.files[0]) || null)}
              />
              {preview && <img className="reg-photo" src={preview} alt="Selected issue" />}
              <button className="submit-btn" disabled={busy} type="submit" style={{ marginTop: 14 }}>
                {busy ? "Saving…" : "Submit issue"}
              </button>
            </form>
          )}

          <p className="report-meta">
            {visible.length} {visible.length === 1 ? "issue" : "issues"}
          </p>
          {visible.length === 0 && <div className="empty-state">No issues to show.</div>}

          {visible.map((issue) => (
            <div className="reg-item" key={issue.id}>
              <div className="reg-item-row">
                <div>
                  <div className="reg-name">{issue.title}</div>
                  <div className="reg-meta">
                    {[issue.category, issue.location].filter(Boolean).join(" · ")}
                  </div>
                  <div className="reg-meta">
                    Reported {whenText(issue.created_at)}
                    {issue.reported_by_name || issue.reported_by_email
                      ? ` by ${issue.reported_by_name || issue.reported_by_email}`
                      : ""}
                    {issue.reported_by_club ? ` (${issue.reported_by_club})` : ""}
                  </div>
                </div>
                <span
                  className={`reg-tag ${
                    issue.status === "resolved" ? "good" : issue.priority === "urgent" ? "warn" : ""
                  }`}
                >
                  {issue.priority === "urgent" && issue.status !== "resolved" ? "URGENT · " : ""}
                  {STATUS_LABEL[issue.status]}
                </span>
              </div>
              {issue.description && <p style={{ margin: "8px 0 0" }}>{issue.description}</p>}
              {photoUrls[issue.photo_path] && (
                <a href={photoUrls[issue.photo_path]} target="_blank" rel="noreferrer">
                  <img className="reg-photo" src={photoUrls[issue.photo_path]} alt={issue.title} />
                </a>
              )}
              {issue.status === "resolved" && (
                <div className="reg-meta">
                  Resolved {issue.resolved_at ? whenText(issue.resolved_at) : ""}
                  {issue.resolution_notes ? ` · ${issue.resolution_notes}` : ""}
                </div>
              )}
              {canEdit && issue.status !== "resolved" && (
                <div className="reg-actions">
                  {issue.status === "open" && (
                    <button
                      type="button"
                      className="reg-btn"
                      disabled={busy}
                      onClick={() => setStatus(issue, "in_progress")}
                    >
                      Mark in progress
                    </button>
                  )}
                  <input
                    className="field"
                    style={{ margin: 0, flex: 1, minWidth: 160 }}
                    placeholder="Resolution note (optional)"
                    value={resolveNotes[issue.id] || ""}
                    onChange={(e) => setResolveNotes((n) => ({ ...n, [issue.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="reg-btn primary"
                    disabled={busy}
                    onClick={() => setStatus(issue, "resolved")}
                  >
                    Mark resolved
                  </button>
                </div>
              )}
              {canEdit && issue.status === "resolved" && (
                <div className="reg-actions">
                  <button type="button" className="reg-btn" disabled={busy} onClick={() => setStatus(issue, "open")}>
                    Reopen
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Access (administrators only)                                         */
/* ------------------------------------------------------------------ */
const ACCESS_AREAS = [
  { key: "lockers", column: "lockers_access", label: "Lockers" },
  { key: "keys", column: "keys_access", label: "Keys" },
  { key: "issues", column: "issues_access", label: "Notifications" },
];

function AccessScreen({ api, isAdmin, onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [busyKey, setBusyKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [club, setClub] = useState("");
  const [position, setPosition] = useState(POSITIONS[0]);

  const [clubLogins, setClubLogins] = useState([]);
  const [clubList, setClubList] = useState([]);
  const [clubEmail, setClubEmail] = useState("");
  const [clubNo, setClubNo] = useState("");

  const load = useCallback(async () => {
    try {
      setRows((await api.rpc("list_register_people")) || []);
    } catch (err) {
      setError(err.message);
      setRows([]);
    }
  }, [api]);

  const loadClubLogins = useCallback(async () => {
    try {
      setClubLogins((await api.rpc("list_club_logins")) || []);
      setClubList((await api.select('ClubT?select=CLUBID,Club_Name&Incorporated=eq.true&order=Club_Name.asc')) || []);
    } catch {
      // The club login tools are added by 013_club_logins.sql; hide the section until it has been run.
      setClubLogins(null);
    }
  }, [api]);

  useEffect(() => {
    if (isAdmin) {
      load();
      loadClubLogins();
    }
  }, [isAdmin, load, loadClubLogins]);

  async function saveClubLogin(e) {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!clubEmail.trim() || !clubNo) return setError("Enter the login email and choose a club.");
    setBusyKey("club");
    try {
      const result = await api.rpc("set_club_login", { p_email: clubEmail.trim(), p_club_no: Number(clubNo) });
      if (!result || result.outcome !== "saved") throw new Error((result && result.message) || "Unable to save.");
      setMessage(result.message);
      setClubEmail("");
      await loadClubLogins();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  async function removeClubLogin(userId) {
    setMessage("");
    setError("");
    setBusyKey(`club:${userId}`);
    try {
      const result = await api.rpc("remove_club_login", { p_user_id: userId });
      if (!result || result.outcome !== "saved") throw new Error((result && result.message) || "Unable to remove.");
      setMessage(result.message);
      await loadClubLogins();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  async function change(row, register, level) {
    setMessage("");
    setError("");
    setBusyKey(`${row.user_id}:${register}`);
    try {
      const result = await api.rpc("set_register_access", {
        p_user_id: row.user_id,
        p_register: register,
        p_access_level: level,
      });
      if (!result || result.outcome !== "saved") {
        throw new Error((result && result.message) || "Unable to update access.");
      }
      setMessage("Access updated.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  async function addPerson(e) {
    e.preventDefault();
    setMessage("");
    setError("");
    if (!email.trim() || !fullName.trim()) return setError("Enter the person's email and name.");

    // President and Treasurer manage lockers and keys; a nominated contact
    // can report and update venue issues only.
    const officer = position === "President" || position === "Treasurer";
    setBusyKey("add");
    try {
      const result = await api.rpc("grant_register_access_by_email", {
        p_email: email.trim(),
        p_full_name: fullName.trim(),
        p_club: club.trim() || null,
        p_position: position,
        p_lockers: officer ? "edit" : "none",
        p_keys: officer ? "edit" : "none",
        p_issues: "edit",
      });
      if (!result || result.outcome !== "saved") {
        throw new Error((result && result.message) || "Unable to add the person.");
      }
      setMessage(`${fullName.trim()} added. You can adjust their access below.`);
      setEmail("");
      setFullName("");
      setClub("");
      setShowAdd(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="reg-wrap">
      <Header title="Manage Access" onHome={onHome} onSignOut={onSignOut} />

      {!isAdmin ? (
        <div className="report-error">Only an administrator can change register access.</div>
      ) : rows === null ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <>
          <p className="reg-hint">
            Administrators always have full access. Everyone else needs access granted here, and needs a login.
          </p>
          <Notice message={message} error={error} />
          <div className="reg-toolbar">
            <button type="button" className="reg-btn" onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "Cancel" : "Add person"}
            </button>
          </div>

          {showAdd && (
            <form className="reg-panel" onSubmit={addPerson}>
              <label className="field-label">Login email</label>
              <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <label className="field-label">Full name</label>
              <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              <label className="field-label">Club</label>
              <input className="field" value={club} onChange={(e) => setClub(e.target.value)} />
              <label className="field-label">Position</label>
              <select className="field" value={position} onChange={(e) => setPosition(e.target.value)}>
                {POSITIONS.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              <p className="reg-hint">
                President and Treasurer get edit access to lockers, keys and notifications. A nominated contact
                gets notifications only.
              </p>
              <button className="submit-btn" disabled={busyKey === "add"} type="submit">
                Save person
              </button>
            </form>
          )}

          {rows.map((row) => (
            <div className="reg-item" key={row.user_id}>
              <div className="reg-name">{row.full_name || row.email || row.user_id}</div>
              <div className="reg-meta">
                {[row.job_position, row.club, row.full_name ? row.email : null].filter(Boolean).join(" · ")}
                {row.role ? ` · sign-in role: ${row.role}` : ""}
              </div>
              {row.role === "admin" ? (
                <div className="reg-meta">Administrator: full access to everything</div>
              ) : (
                <div className="reg-access-grid">
                  {ACCESS_AREAS.map((area) => (
                    <div key={area.key}>
                      <label className="field-label">{area.label}</label>
                      <select
                        className="field"
                        value={row[area.column] || "none"}
                        disabled={busyKey === `${row.user_id}:${area.key}`}
                        onChange={(e) => change(row, area.key, e.target.value)}
                      >
                        <option value="none">No access</option>
                        <option value="view">View</option>
                        <option value="edit">Edit</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {clubLogins !== null && (
            <>
              <h2 className="reg-name" style={{ margin: "28px 0 4px" }}>Club logins</h2>
              <p className="reg-hint">
                A club login can open Member Lookup (only the members of its own club) and can report Notifications.
                Nothing else. The person needs a login first (Supabase, Authentication, Users).
              </p>
              <form className="reg-panel" onSubmit={saveClubLogin}>
                <label className="field-label">Login email</label>
                <input className="field" type="email" value={clubEmail} onChange={(e) => setClubEmail(e.target.value)} />
                <label className="field-label">Club</label>
                <select className="field" value={clubNo} onChange={(e) => setClubNo(e.target.value)}>
                  <option value="">Choose a club…</option>
                  {clubList.map((c) => (
                    <option key={c.CLUBID} value={c.CLUBID}>
                      {c.Club_Name}
                    </option>
                  ))}
                </select>
                <button className="submit-btn" disabled={busyKey === "club"} type="submit">
                  Restrict this login to the club
                </button>
              </form>
              {clubLogins.length === 0 && <div className="reg-meta">No club logins yet.</div>}
              {clubLogins.map((c) => (
                <div className="reg-item" key={c.user_id}>
                  <div className="reg-item-row">
                    <div>
                      <div className="reg-name">{c.email}</div>
                      <div className="reg-meta">{c.club_name || `Club ${c.club_no}`} · Member Lookup and Notifications</div>
                    </div>
                    <button
                      type="button"
                      className="reg-btn danger"
                      disabled={busyKey === `club:${c.user_id}`}
                      onClick={() => removeClubLogin(c.user_id)}
                    >
                      Remove restriction
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Entry point used by the portal                                       */
/* ------------------------------------------------------------------ */
export default function RegistersApp({ view, session, supabaseUrl, anonKey, access, onHome, onSignOut }) {
  const api = useMemo(
    () => createApi(supabaseUrl, anonKey, session.access_token),
    [supabaseUrl, anonKey, session.access_token]
  );

  if (view === "reg-lockers") {
    return <RegisterScreen kind="lockers" api={api} level={access.lockers} onHome={onHome} onSignOut={onSignOut} />;
  }
  if (view === "reg-keys") {
    return <RegisterScreen kind="keys" api={api} level={access.keys} onHome={onHome} onSignOut={onSignOut} />;
  }
  if (view === "reg-issues") {
    return <IssuesScreen api={api} level={access.issues} onHome={onHome} onSignOut={onSignOut} />;
  }
  return <AccessScreen api={api} isAdmin={access.admin} onHome={onHome} onSignOut={onSignOut} />;
}
