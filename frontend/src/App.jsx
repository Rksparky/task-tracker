import { useEffect, useRef, useState } from "react";
import ActivityFlow from "./ServiceActivity";

const API = import.meta.env.VITE_API ?? (import.meta.env.PROD ? "" : "http://localhost:8000");
const STATUSES = ["Pending", "In Progress", "Completed"];
const COLORS = { Pending: "#f59e0b", "In Progress": "#2563eb", Completed: "#16a34a" };
const EMPTY = { task: "", work_update: "", assigned_to: "", assigned_by: "", deadline: "", status: "Pending" };

let onExpired = () => {};
async function api(path, opts = {}) {
  const token = localStorage.getItem("token");
  const r = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
  });
  if (r.status === 401 && path !== "/api/login") onExpired();
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Request failed");
  return r.json();
}

const parseD = (s) => { const m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const dayDiff = (s) => { const d = parseD(s); return d ? Math.round((d - midnight()) / 864e5) : null; };
const toISO = (s) => { const d = parseD(s); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : ""; };
const toDMY = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const count = (list, s) => list.filter((t) => t.status === s).length;
const slug = (s) => (s || "pending").toLowerCase().replace(/\s+/g, "-");
function dueLabel(t) {
  const n = dayDiff(t.deadline);
  if (n === null) return "No deadline";
  if (t.status !== "Completed" && n < 0) return `Overdue · ${t.deadline}`;
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : t.deadline;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const logout = () => { localStorage.removeItem("token"); setUser(null); };
  useEffect(() => {
    onExpired = logout;
    if (!localStorage.getItem("token")) return setReady(true);
    api("/api/me").then(setUser).catch(() => {}).finally(() => setReady(true));
  }, []);
  if (!ready) return <div className="auth"><p className="muted">Loading…</p></div>;
  return user ? <Shell user={user} logout={logout} /> : <Login onLogin={setUser} />;
}

function Login({ onLogin }) {
  const [f, setF] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const r = await api("/api/login", { method: "POST", body: JSON.stringify(f) });
      localStorage.setItem("token", r.token); onLogin(r.user);
    } catch (x) {
      setErr(x.message === "Failed to fetch" ? "Can't reach the server. It may be waking up, so try again in a minute." : x.message);
    }
    setBusy(false);
  };
  return (
    <div className="auth">
      <form className="card login" onSubmit={submit}>
        <img className="logo-full" src="/logo.png" alt="GVR Groups" />
        <div className="brand">GVR ERP</div>
        <h1>Sign in</h1>
        <p className="muted">Sign in to continue to your account.</p>
        <label>Username<input autoFocus required autoComplete="username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
        <label>Password<input required type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Log in"}</button>
      </form>
    </div>
  );
}

function Shell({ user, logout }) {
  const [page, setPage] = useState("dashboard");
  const [tasks, setTasks] = useState([]);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [known, setKnown] = useState([]);
  useEffect(() => { api("/api/people").then((p) => setKnown(p.map((x) => x.name))).catch(() => {}); }, []);
  const people = mergeNames(known, tasks.flatMap((t) => [t.assigned_to, t.assigned_by]));
  const reload = async () => setTasks(await api("/api/tasks"));

  useEffect(() => {
    let v = -1;
    const tick = async () => {
      try {
        const { version } = await api("/api/version");
        if (version !== v) { v = version; await reload(); }
        setLive(true);
      } catch { setLive(false); }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  const act = async (fn) => { try { setError(""); await fn(); await reload(); } catch (e) { setError(e.message); } };
  const patch = (id, body) => act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
  // The pop-up stays open until the server confirms, and shows any error inside it.
  const save = async (e) => {
    e.preventDefault();
    const { id, assigned_by, assigned_to, task, deadline, status, work_update } = form;
    const body = JSON.stringify({ assigned_by, assigned_to, task, deadline, status, work_update });
    setSaving(true); setFormErr("");
    try {
      await api(id ? `/api/tasks/${id}` : "/api/tasks", { method: id ? "PATCH" : "POST", body });
      await reload(); setForm(null);
    } catch (x) {
      setFormErr(x.message === "Failed to fetch" ? "Can't reach the server. It may be waking up, so try again in a minute." : x.message);
    }
    setSaving(false);
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const isAdmin = user.role.toLowerCase() === "admin";
  const nav = [["dashboard", "Dashboard"], ["tasks", "Tasks"], ["services", "Services"], ["projects", "Projects"], ["attendance", "Attendance"], ["track", "Track"], ...(isAdmin ? [["admin", "Admin report"]] : []), ["profile", "Profile"]];

  return (
    <div className="app">
      <aside>
        <div className="brand"><img className="logo-img" src="/logo-mark.png" alt="" />GVR ERP</div>
        <nav>{nav.map(([k, label]) => <button key={k} className={page === k ? "nav active" : "nav"} onClick={() => setPage(k)}>{label}</button>)}</nav>
        <button className="nav out" onClick={logout}>Logout</button>
      </aside>
      <div className="main">
        <header className="top">
          <span className="sync"><span className={"dot " + (live ? "on" : "off")} />{live ? "Synced with Google Sheets" : "Can't reach the server"}</span>
          <button className="me" onClick={() => setPage("profile")}><span className="avatar">{initials(user.name)}</span>{user.name}</button>
        </header>
        {error && <div className="error" role="alert">{error}</div>}
        {page === "dashboard" && <Dashboard user={user} tasks={tasks} go={setPage} />}
        {page === "tasks" && <Tasks tasks={tasks} patch={patch} act={act} open={(t) => { setFormErr(""); setForm(t || { ...EMPTY, assigned_by: user.name }); }} />}
        {page === "profile" && <Profile user={user} tasks={tasks} logout={logout} />}
        {page === "attendance" && <Attendance />}
        {page === "track" && <Track />}
        {page === "services" && <Records key="services" kind="services" user={user} people={people} />}
        {page === "projects" && <Records key="projects" kind="projects" user={user} people={people} />}
        {page === "admin" && isAdmin && <Admin />}
      </div>

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <form className="modal card" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{form.id ? "Edit task" : "Add new task"}</h2>
            <label>Task title *<input required value={form.task} onChange={set("task")} /></label>
            <label>Work update<textarea rows="3" value={form.work_update} onChange={set("work_update")} /></label>
            <div className="two">
              <label>Assigned to<input value={form.assigned_to} onChange={set("assigned_to")} /></label>
              <label>Assigned by<input value={form.assigned_by} onChange={set("assigned_by")} /></label>
              <label>Due date<input type="date" value={toISO(form.deadline)} onChange={(e) => setForm({ ...form, deadline: toDMY(e.target.value) })} /></label>
              <label>Status<select value={form.status} onChange={set("status")}>{[...new Set([...STATUSES, form.status])].map((s) => <option key={s}>{s}</option>)}</select></label>
            </div>
            {formErr && <div className="error" role="alert">{formErr}</div>}
            <div className="row end"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary" disabled={saving}>{saving ? "Saving…" : form.id ? "Save changes" : "Add task"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function Dashboard({ user, tasks, go }) {
  const [svc, setSvc] = useState(null);
  const [prj, setPrj] = useState(null);
  useEffect(() => {
    const load = () => {
      api("/api/records/services").then(setSvc).catch(() => setSvc([]));
      api("/api/records/projects").then(setPrj).catch(() => setPrj([]));
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">Welcome back, {user.name.split(" ")[0]}. Here's what's happening with your work today.</p>
      <div className="trio">
        <Summary title="Tasks" page="tasks" go={go} rows={tasks} statuses={STATUSES} done={["Completed"]} doneLabel="Completed"
          dueKey="deadline" label={(r) => r.task} sub={(r) => r.assigned_to} />
        <Summary title="Services" page="services" go={go} rows={svc} statuses={["New", "In Progress", "Resolved", "Closed"]} done={["Resolved", "Closed"]} doneLabel="Resolved"
          dueKey="expected_closure" label={(r) => r.company} sub={(r) => r.problem || r.problem_type || r.service_type} money={{ key: "amount", label: "Total amount" }} />
        <Summary title="Projects" page="projects" go={go} rows={prj} statuses={["Planned", "In Progress", "On Hold", "Completed"]} done={["Completed"]} doneLabel="Completed"
          dueKey="expected_end_date" label={(r) => r.project_name} sub={(r) => r.company} money={{ key: "project_cost", label: "Total project cost" }} />
      </div>
    </>
  );
}

function Tasks({ tasks, patch, act, open }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("All");
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const cols = [["task", "Title"], ["assigned_to", "Assigned to"], ["assigned_by", "Assigned by"], ["due", "Due"], ["status", "Status"]];
  const val = (t, k) => (k === "due" ? parseD(t.deadline)?.getTime() ?? Infinity : k === "status" ? STATUSES.indexOf(t.status) : (t[k] || "").toLowerCase());
  const cmp = (a, b) => {
    const x = val(a, sort.key), y = val(b, sort.key);
    if (x === y) return 0;
    if (x === Infinity) return 1;
    if (y === Infinity) return -1;
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
  };
  const toggle = (k) => setSort((s) => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: 1 }));
  const filtered = tasks.filter((t) => (tab === "All" || t.status === tab) && `${t.task} ${t.assigned_to} ${t.assigned_by} ${t.work_update}`.toLowerCase().includes(q.toLowerCase()));
  const shown = sort.key ? [...filtered].sort(cmp) : filtered;
  return (
    <>
      <div className="row between wrap">
        <div><h1>Tasks</h1><p className="muted">Manage your tasks and stay on track.</p></div>
        <div className="row"><input className="search" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="primary" onClick={() => open()}>+ Add task</button></div>
      </div>
      <div className="tabs">{["All", ...STATUSES].map((s) => <button key={s} className={tab === s ? "tab active" : "tab"} onClick={() => setTab(s)}>{s} ({s === "All" ? tasks.length : count(tasks, s)})</button>)}</div>
      <div className="card scroll">
        <table>
          <thead><tr>{cols.map(([k, label]) => (
            <th key={k} aria-sort={sort.key === k ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
              <button className="sortbtn" onClick={() => toggle(k)}>{label}<span>{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : " ↕"}</span></button>
            </th>
          ))}<th /></tr></thead>
          <tbody>
            {shown.map((t) => (
              <tr key={t.id}>
                <td><b>{t.task}</b>{t.work_update && <small className="clip">{t.work_update.split("\n").pop()}</small>}</td>
                <td>{t.assigned_to}</td><td>{t.assigned_by}</td>
                <td className={dayDiff(t.deadline) < 0 && t.status !== "Completed" ? "late" : ""}>{dueLabel(t)}</td>
                <td><select className={"pill " + slug(t.status)} value={t.status} onChange={(e) => patch(t.id, { status: e.target.value })}>{[...new Set([...STATUSES, t.status])].map((s) => <option key={s}>{s}</option>)}</select></td>
                <td className="row"><button onClick={() => open(t)}>Edit</button><button className="danger" onClick={() => confirm("Delete this task from the Google Sheet?") && act(() => api(`/api/tasks/${t.id}`, { method: "DELETE" }))}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">No tasks match.</p>}
      </div>
    </>
  );
}

function Profile({ user, tasks, logout }) {
  const n = user.name.toLowerCase();
  const mine = tasks.filter((t) => { const a = (t.assigned_to || "").toLowerCase(); return a && (n.startsWith(a) || a.startsWith(n)); });
  return (
    <>
      <h1>Profile</h1>
      <div className="card profile">
        <span className="avatar big">{initials(user.name)}</span>
        <div><h2>{user.name}</h2><p className="muted">{user.role} · @{user.username}</p></div>
        <button className="danger" onClick={logout}>Log out</button>
      </div>
      <div className="stats">
        {[["Assigned to me", mine.length], ["Pending", count(mine, "Pending")], ["In progress", count(mine, "In Progress")], ["Completed", count(mine, "Completed")]].map(([l, v]) => <div className="card stat" key={l}><span className="muted">{l}</span><b>{v}</b></div>)}
      </div>
      <Password />
      <section className="card">
        <h2>My open tasks</h2>
        {mine.filter((t) => t.status !== "Completed").map((t) => <div className="item" key={t.id}><b>{t.task}</b><div className="right"><span className={"pill " + slug(t.status)}>{t.status}</span><small>{dueLabel(t)}</small></div></div>)}
        {!mine.some((t) => t.status !== "Completed") && <p className="muted pad">No open tasks. Tasks are matched by your name in "Assigned to".</p>}
      </section>
    </>
  );
}

/* ---------- location helpers ---------- */
const getPos = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) return reject(new Error("This browser doesn't support location."));
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (e) => reject(new Error(e.code === 1 ? "Location is blocked. Allow location access for this site in your browser settings." : "Couldn't get your location. Try again.")),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
});
const hav = (a, b) => {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 12742.0176 * Math.asin(Math.sqrt(h));
};
const pathKm = (pts) => pts.reduce((s, p, i) => (i ? s + hav(pts[i - 1], p) : s), 0);

function Attendance() {
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("/api/attendance/today").then(setInfo).catch(() => {}); }, []);
  const mark = async () => {
    setBusy(true); setMsg("");
    try { const r = await api("/api/attendance", { method: "POST", body: JSON.stringify(await getPos()) }); setInfo(r); setMsg(r.message); }
    catch (e) { setMsg(e.message); }
    setBusy(false);
  };
  const ok = info?.checked_in;
  return (
    <>
      <h1>Attendance</h1>
      <p className="muted">Tap the button to mark your attendance. Your location is recorded at that moment.</p>
      <div className="card center">
        <h2>{ok ? `Present today · ${info.time}` : "Not marked yet today"}</h2>
        {!ok && <button className="primary big" disabled={busy} onClick={mark}>{busy ? "Checking location…" : "Mark attendance"}</button>}
        {msg && <div className={ok ? "okmsg" : "error"} role="status">{msg}</div>}
      </div>
    </>
  );
}

function Track() {
  const [trip, setTrip] = useState(() => JSON.parse(localStorage.getItem("trip") || "null"));
  const ref = useRef(trip);
  const [form, setForm] = useState({ vehicle: "Bike", destination: "" });
  const [acc, setAcc] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [past, setPast] = useState([]);
  const [, tick] = useState(0);
  const loadPast = () => api("/api/trips").then(setPast).catch(() => {});
  const update = (t) => { ref.current = t; t ? localStorage.setItem("trip", JSON.stringify(t)) : localStorage.removeItem("trip"); setTrip(t); };
  useEffect(() => { loadPast(); }, []);

  useEffect(() => {
    if (!trip) return;
    let lock;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    const id = navigator.geolocation.watchPosition((p) => {
      setAcc(Math.round(p.coords.accuracy));
      if (p.coords.accuracy > 100) return;
      const pt = [p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy)];
      const cur = ref.current, last = cur.points[cur.points.length - 1];
      if (!last || hav(last, pt) >= 0.02) update({ ...cur, points: [...cur.points, pt] });
    }, () => setMsg("Location signal lost. Keep this page open and allow location access."), { enableHighAccuracy: true, maximumAge: 5000 });
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => { navigator.geolocation.clearWatch(id); clearInterval(clock); lock?.release?.(); };
  }, [!!trip]);

  const start = async () => {
    setBusy(true); setMsg(""); setResult(null);
    try { const p = await getPos(); update({ ...form, started: new Date().toISOString(), points: [[p.lat, p.lng, Math.round(p.accuracy)]] }); }
    catch (e) { setMsg(e.message); }
    setBusy(false);
  };
  const end = async () => {
    setBusy(true); setMsg("");
    try {
      let t = ref.current;
      try { const p = await getPos(); const pt = [p.lat, p.lng, Math.round(p.accuracy)]; if (hav(t.points[t.points.length - 1], pt) >= 0.02) t = { ...t, points: [...t.points, pt] }; } catch {}
      const r = await api("/api/trips", { method: "POST", body: JSON.stringify({ vehicle: t.vehicle, destination: t.destination, started: t.started, ended: new Date().toISOString(), points: t.points }) });
      setResult(r); update(null); loadPast();
    } catch (e) { setMsg(e.message + " Your trip is still saved on this phone; try End trip again."); }
    setBusy(false);
  };

  const secs = trip ? Math.floor((Date.now() - new Date(trip.started)) / 1000) : 0;
  return (
    <>
      <h1>Track trip</h1>
      <p className="muted">Start tracking at your starting point and end it at your destination. Keep this page open with the screen on.</p>
      <div className="card center">
        {trip ? (
          <>
            <span className="muted">Tracking {trip.vehicle}{trip.destination && ` to ${trip.destination}`}</span>
            <div className="live">{pathKm(trip.points).toFixed(2)} km</div>
            <small>{Math.floor(secs / 60)} min {secs % 60} s · GPS accuracy {acc ?? "…"} m · {trip.points.length} points</small>
            <div className="row">
              <button className="primary big" disabled={busy} onClick={end}>{busy ? "Saving…" : "End trip"}</button>
              <button disabled={busy} onClick={() => confirm("Discard this trip?") && update(null)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className="two full">
              <label>Vehicle<select value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })}><option>Bike</option><option>Car</option></select></label>
              <label>Destination (optional)<input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} /></label>
            </div>
            <button className="primary big" disabled={busy} onClick={start}>{busy ? "Getting location…" : "Start tracking"}</button>
          </>
        )}
        {msg && <div className="error" role="alert">{msg}</div>}
        {result && <div className="okmsg">Trip saved: {result.distance_km} km · petrol about {result.petrol_l} L · ₹{result.cost}</div>}
      </div>
      <section className="card">
        <h2>My recent trips</h2>
        <div className="scroll"><table><thead><tr><th>Date</th><th>Destination</th><th>Vehicle</th><th>Distance</th><th>Petrol</th><th>Cost</th></tr></thead>
          <tbody>{past.map((t, i) => <tr key={i}><td>{t.date}</td><td>{t.destination || "—"}</td><td>{t.vehicle}</td><td>{t.km} km</td><td>{t.litres} L</td><td>₹{t.cost}</td></tr>)}</tbody></table></div>
        {!past.length && <p className="muted pad">No trips yet.</p>}
      </section>
    </>
  );
}

function Admin() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const load = () => api("/api/admin/report").then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);
  if (!d) return <p className="muted">{err || "Loading report…"}</p>;
  const sum = (k) => d.trips.reduce((s, t) => s + (+t[k] || 0), 0);
  const here = d.today.filter((s) => s.present).length;
  return (
    <>
      <div className="row between wrap"><div><h1>Admin report</h1><p className="muted">Attendance and travel from your team. Refreshes every 30 seconds.</p></div><button onClick={load}>Refresh</button></div>
      <div className="stats">
        {[["Present today", `${here} / ${d.today.length}`], ["Trips", d.trips.length], ["Distance", `${sum("km").toFixed(1)} km`], ["Petrol", `${sum("litres").toFixed(1)} L`], ["Petrol cost", `₹${Math.round(sum("cost"))}`]]
          .map(([l, v]) => <div className="card stat" key={l}><span className="muted">{l}</span><b>{v}</b></div>)}
      </div>
      <section className="card"><h2>Today's attendance</h2>
        <div className="scroll"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Time</th><th>Location</th></tr></thead>
          <tbody>{d.today.map((s) => <tr key={s.username}><td>{s.name}</td><td>{s.role}</td><td><span className={"pill " + (s.present ? "completed" : "")}>{s.present ? "Present" : "Not yet"}</span></td><td>{s.time || "—"}</td><td>{s.map ? <a href={s.map} target="_blank" rel="noreferrer">Map</a> : "—"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="card"><h2>Trips and petrol</h2>
        <div className="scroll"><table><thead><tr><th>Date</th><th>Name</th><th>Destination</th><th>Vehicle</th><th>Time</th><th>Distance</th><th>Petrol</th><th>Cost</th><th>Route</th></tr></thead>
          <tbody>{d.trips.map((t, i) => <tr key={i}><td>{t.date}</td><td>{t.name}</td><td>{t.destination || "—"}</td><td>{t.vehicle}</td><td>{t.started}–{t.ended}</td><td>{t.km} km</td><td>{t.litres} L</td><td>₹{t.cost}</td><td><a href={t.route} target="_blank" rel="noreferrer">Map</a></td></tr>)}</tbody></table></div>
        {!d.trips.length && <p className="muted pad">No trips yet.</p>}
      </section>
      <section className="card"><h2>Attendance history</h2>
        <div className="scroll"><table><thead><tr><th>Date</th><th>Name</th><th>Time</th><th>Distance from office</th><th>Location</th></tr></thead>
          <tbody>{d.attendance.map((a, i) => <tr key={i}><td>{a.date}</td><td>{a.name}</td><td>{a.time}</td><td>{a.distance_m ? a.distance_m + " m" : "—"}</td><td>{a.map ? <a href={a.map} target="_blank" rel="noreferrer">Map</a> : "—"}</td></tr>)}</tbody></table></div>
        {!d.attendance.length && <p className="muted pad">No attendance yet.</p>}
      </section>
    </>
  );
}

function Password() {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setMsg(null);
    if (f.next !== f.again) return setMsg({ bad: true, text: "The new passwords don't match." });
    setBusy(true);
    try {
      await api("/api/password", { method: "POST", body: JSON.stringify({ current: f.current, new: f.next }) });
      setF({ current: "", next: "", again: "" }); setMsg({ text: "Password changed. Use the new one next time you log in." });
    } catch (x) { setMsg({ bad: true, text: x.message }); }
    setBusy(false);
  };
  const field = (k, label, auto) => <label>{label}<input required type="password" autoComplete={auto} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <form className="card pw" onSubmit={submit}>
      <h2>Change password</h2>
      {field("current", "Current password", "current-password")}
      {field("next", "New password (8+ characters)", "new-password")}
      {field("again", "Repeat new password", "new-password")}
      {msg && <div className={msg.bad ? "error" : "okmsg"} role="status">{msg.text}</div>}
      <button className="primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
    </form>
  );
}


/* ---------- Services and Projects ---------- */
function mergeNames(...lists) {  // names already involved, "Ranjith" + "Ranjith Kumar" count as one
  const out = [];
  lists.flat().filter(Boolean).forEach((n) => {
    const l = n.toLowerCase();
    const i = out.findIndex((o) => o.toLowerCase().startsWith(l) || l.startsWith(o.toLowerCase()));
    if (i < 0) out.push(n); else if (n.length > out[i].length) out[i] = n;
  });
  return out.sort((a, b) => a.localeCompare(b));
}
const pad = (n) => String(n).padStart(2, "0");
const todayDMY = () => { const d = new Date(); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ACTIVITY = ["Fault", "Installation", "Maintenance", "Follow-up", "Meeting", "Payment"];
const PRIORITY = ["Low", "Normal", "High", "Urgent"];
const SERVICE_TYPES = ["Installation", "Repair", "AMC", "Support"];
// field = [key, label, type, options, default]
const COMPANY = [["company", "Company", "text"], ["contact", "Contact", "text"], ["channel_partner", "Channel partner", "text"], ["address", "Address", "text"],
  ["contact_mobile", "Mobile", "text"], ["contact_email", "Email", "email"], ["manager", "Manager", "text"], ["manager_mobile", "Manager mobile", "text"], ["manager_email", "Manager email", "email"]];
const KINDS = {
  services: {
    title: "Services", modal: "Add service", edit: "Edit service", submit: "Ticket", activity: "Fault",
    company: [["serial_no", "Serial no.", "text"], ...COMPANY, ["email_subject", "Email subject line", "text"]],
    details: [["type", "Type", "select", ["Chargeable", "Non-chargeable", "Warranty", "AMC"], "Chargeable"], ["generate_otp", "Generate OTP", "check"],
      ["amount", "Amount", "number", null, "0"], ["open_date", "Open date", "date", null, "today"], ["expected_closure", "Expected closure date", "date", null, "today"],
      ["problem_type", "Problem type", "select", ["Fault", "Installation", "Maintenance", "Other"], "Fault"], ["problem", "Problem", "text"],
      ["status", "Status", "select", ["New", "In Progress", "Resolved", "Closed"], "New"], ["priority", "Priority", "select", PRIORITY, "Normal"],
      ["document_number", "Document number", "text"], ["branch", "Branch", "text", null, "Chennai Head Office"],
      ["service_type", "Service type", "select", SERVICE_TYPES, ""], ["service_amount", "Service amount", "number", null, "0"]],
    cols: [["id", "ID"], ["company", "Company"], ["contact", "Contact"], ["service_type", "Service type"], ["problem_type", "Problem"], ["status", "Status"], ["priority", "Priority"], ["expected_closure", "Closure date"], ["amount", "Amount"]],
  },
  projects: {
    title: "Projects", modal: "Create project", edit: "Edit project", submit: "Create project", activity: "Follow-up",
    company: [...COMPANY, ["project_name", "Project name", "text"]],
    details: [["source", "Source", "select", ["Campaign", "Reference", "Website", "Walk-in", "Existing customer"], "Campaign"], ["show_in_pdf", "Show in PDF", "check"],
      ["source_details", "Source details", "text"], ["start_date", "Start date", "date", null, "today"], ["expected_end_date", "Expected end date", "date", null, "today"],
      ["status", "Status", "select", ["Planned", "In Progress", "On Hold", "Completed"], "In Progress"], ["priority", "Priority", "select", PRIORITY, "Normal"],
      ["document_number", "Document number", "text"], ["branch", "Branch", "text", null, "Chennai Head Office"],
      ["service_type", "Service type", "select", SERVICE_TYPES, ""], ["project_cost", "Project cost", "number", null, "0"]],
    cols: [["id", "ID"], ["project_name", "Project"], ["company", "Company"], ["source", "Source"], ["status", "Status"], ["priority", "Priority"], ["start_date", "Start"], ["expected_end_date", "End"], ["project_cost", "Cost"]],
  },
};

function Field({ f, v, set }) {
  const [key, label, type, opts] = f;
  if (type === "check") return <label className="chk"><input type="checkbox" checked={v === "Yes"} onChange={(e) => set(key, e.target.checked ? "Yes" : "No")} />{label}</label>;
  if (type === "select") return <label>{label}<select value={v} onChange={(e) => set(key, e.target.value)}><option value="">Select…</option>{opts.map((o) => <option key={o}>{o}</option>)}</select></label>;
  if (type === "date") return <label>{label}<input type="date" value={toISO(v)} onChange={(e) => set(key, toDMY(e.target.value))} /></label>;
  return <label>{label}<input type={type} value={v} required={key === "company" || key === "project_name"} onChange={(e) => set(key, e.target.value)} /></label>;
}

function Records({ kind, user, people }) {
  const cfg = KINDS[kind];
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(null);
  const [sched, setSched] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [flow, setFlow] = useState(null);  // service ticket being worked on
  const sameName = (a, b) => { a = (a || "").trim().toLowerCase(); b = (b || "").trim().toLowerCase(); return !!a && !!b && (a.startsWith(b) || b.startsWith(a)); };
  const isMine = (r) => kind === "services" && sameName(r.action?.actor, user.name) && !["Resolved", "Closed"].includes(r.status);
  const started = (r) => r.status === "In Progress";
  const accept = async (r) => {
    setErr("");
    try { await api(`/api/records/services/${r.id}/accept`, { method: "POST" }); await load(); setFlow({ ...r, status: "In Progress" }); }
    catch (x) { setErr(x.message); }
  };
  const load = () => api(`/api/records/${kind}`).then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); const id = setInterval(load, 30000); return () => clearInterval(id); }, []);

  const open = () => {
    setErr("");
    const data = {};
    [...cfg.company, ...cfg.details].forEach(([k, , t, , d]) => { data[k] = d === "today" ? todayDMY() : t === "check" ? "No" : d ?? ""; });
    setForm({ data: { ...data, manager: user.name, description: "" }, action: null });
  };
  const openEdit = (r) => {
    setErr("");
    const data = { description: r.description || "" };
    [...cfg.company, ...cfg.details].forEach(([k, , t]) => { data[k] = r[k] || (t === "check" ? "No" : ""); });
    setForm({ id: r.id, data, action: r.action });
  };
  const set = (k, v) => setForm((f) => ({ ...f, data: { ...f.data, [k]: v } }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { await api(form.id ? `/api/records/${kind}/${form.id}` : `/api/records/${kind}`, { method: form.id ? "PATCH" : "POST", body: JSON.stringify({ data: form.data, action: form.action }) }); setForm(null); await load(); }
    catch (x) { setErr(x.message); }
    setBusy(false);
  };
  const cell = (r, k) => k === "status" ? <span className={"pill " + slug(r[k])}>{r[k] || "—"}</span> : ["amount", "project_cost"].includes(k) ? `₹${r[k] || 0}` : r[k] || "—";
  const shown = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="row between wrap">
        <div><h1>{cfg.title}</h1><p className="muted">{rows.length} {cfg.title.toLowerCase()} listed.</p></div>
        <div className="row"><input className="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="primary" onClick={open}>+ Add {cfg.title.slice(0, -1).toLowerCase()}</button></div>
      </div>
      {err && !form && <div className="error" role="alert">{err}</div>}
      <div className="card scroll">
        <table>
          <thead><tr>{cfg.cols.map(([, l]) => <th key={l}>{l}</th>)}<th>Scheduled action</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className={isMine(r) ? "mine" : ""} onClick={isMine(r) && started(r) ? () => setFlow(r) : undefined}>
                {cfg.cols.map(([k]) => <td key={k}>{cell(r, k)}</td>)}
                <td>{r.action ? `${r.action.mode} · ${r.action.date} ${r.action.time}${r.action.actor ? " · " + r.action.actor : ""}` : "—"}</td>
                <td>
                  <div className="row">
                    {isMine(r) && !started(r) && <button className="primary" onClick={(e) => { e.stopPropagation(); accept(r); }}>Accept &amp; start</button>}
                    {isMine(r) && started(r) && <button className="primary" onClick={(e) => { e.stopPropagation(); setFlow(r); }}>Open ticket</button>}
                    <button onClick={(e) => { e.stopPropagation(); openEdit(r); }}>Edit</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted pad">No {cfg.title.toLowerCase()} yet. Click "Add" to create the first one.</p>}
      </div>

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <form className="modal card rec" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <div className="titlebar"><h2>{form.id ? cfg.edit : cfg.modal}</h2><button type="button" aria-label="Close" onClick={() => setForm(null)}>✕</button></div>
            <div className="panels">
              <div><h3>For company</h3><div className="panel">{cfg.company.map((f) => <Field key={f[0]} f={f} v={form.data[f[0]]} set={set} />)}</div></div>
              <div><h3>Details</h3><div className="panel two">{cfg.details.map((f) => <Field key={f[0]} f={f} v={form.data[f[0]]} set={set} />)}</div></div>
              <div><h3>Description</h3><div className="panel"><textarea rows="12" value={form.data.description} onChange={(e) => set("description", e.target.value)} /></div></div>
            </div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="row between">
              <button type="button" className="link" onClick={() => setSched(true)}>Schedule action{form.action ? ` ✓ ${form.action.mode}, ${form.action.date} ${form.action.time}${form.action.actor ? ", " + form.action.actor : ""}` : ""}</button>
              <button className="primary" disabled={busy}>{busy ? "Saving…" : form.id ? "Save changes" : cfg.submit}</button>
            </div>
          </form>
        </div>
      )}
      {flow && <ActivityFlow ticket={flow} user={user} people={people} api={api} onClose={() => setFlow(null)} onDone={() => { setFlow(null); load(); }} />}
      {sched && form && <Schedule initial={form.action} people={people} defType={cfg.activity} onClose={() => setSched(false)} onSave={(a) => { setForm({ ...form, action: a }); setSched(false); }} />}
    </>
  );
}

function Schedule({ initial, people, defType, onSave, onClose }) {
  const [a, setA] = useState(initial || { mode: "Visit", activity_type: defType, date: todayDMY(), time: nowHM(), alert_unit: "Hours", alert_value: "1", actor: "", notify_mobile: "No", mobile: "", notify_email: "No", email: "", instruction: "" });
  const s = (k) => (e) => setA({ ...a, [k]: e.target.value });
  const chk = (k) => (e) => setA({ ...a, [k]: e.target.checked ? "Yes" : "No" });
  return (
    <div className="overlay top" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="titlebar"><h2>Schedule action</h2><button type="button" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="modes">{[["Visit", "👤"], ["Email", "✉️"], ["Call", "📞"], ["Online", "🖥️"]].map(([m, i]) => (
          <label key={m} className="mode"><input type="radio" name="mode" checked={a.mode === m} onChange={() => setA({ ...a, mode: m })} />{i} {m}</label>))}</div>
        <div className="two">
          <label>Activity type<select value={a.activity_type} onChange={s("activity_type")}>{ACTIVITY.map((o) => <option key={o}>{o}</option>)}</select></label>
          <div className="two">
            <label>Date<input type="date" value={toISO(a.date)} onChange={(e) => setA({ ...a, date: toDMY(e.target.value) })} /></label>
            <label>Time<input type="time" value={a.time} onChange={s("time")} /></label>
          </div>
          <label>Alert before<select value={a.alert_unit} onChange={s("alert_unit")}><option>Minutes</option><option>Hours</option><option>Days</option></select></label>
          <label>How many<select value={a.alert_value} onChange={s("alert_value")}>{[1, 2, 3, 4, 5, 6, 12, 24].map((n) => <option key={n}>{n}</option>)}</select></label>
        </div>
        <label>Actor<select value={a.actor} onChange={s("actor")}><option value="">Select actor</option>{people.map((n) => <option key={n}>{n}</option>)}</select></label>
        <div className="two">
          <label><span className="inl"><input type="checkbox" checked={a.notify_mobile === "Yes"} onChange={chk("notify_mobile")} />Mobile</span><input value={a.mobile} onChange={s("mobile")} /></label>
          <label><span className="inl"><input type="checkbox" checked={a.notify_email === "Yes"} onChange={chk("notify_email")} />Email</span><input type="email" value={a.email} onChange={s("email")} /></label>
        </div>
        <label>Instruction<textarea rows="4" value={a.instruction} onChange={s("instruction")} /></label>
        <div className="row end"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" onClick={() => onSave(a)}>Save</button></div>
      </div>
    </div>
  );
}

const STATUS_COLORS = { Pending: "#f59e0b", New: "#8b5cf6", Planned: "#8b5cf6", "In Progress": "#2563eb", "On Hold": "#ef4444", Resolved: "#16a34a", Completed: "#16a34a", Closed: "#6b7280", Other: "#9ca3af" };

// One card layout used for Tasks, Services and Projects: counts, pie chart by status, and what is due soonest.
function Summary({ title, page, go, rows, statuses, done, doneLabel, dueKey, label, sub, money }) {
  if (!rows) return <section className="card sum"><h2>{title}</h2><p className="muted pad">Loading…</p></section>;
  const total = rows.length;
  const other = total - statuses.reduce((n, s) => n + rows.filter((r) => r.status === s).length, 0);
  const names = other ? [...statuses, "Other"] : statuses;
  const cnt = (s) => (s === "Other" ? other : rows.filter((r) => r.status === s).length);
  const open = rows.filter((r) => !done.includes(r.status));
  const overdue = open.filter((r) => dayDiff(r[dueKey]) < 0).length;
  const dueToday = open.filter((r) => dayDiff(r[dueKey]) === 0).length;
  const soon = open.filter((r) => parseD(r[dueKey])).sort((a, b) => parseD(a[dueKey]) - parseD(b[dueKey])).slice(0, 5);
  const colour = (s) => STATUS_COLORS[s] || "#9ca3af";
  const when = (r) => { const n = dayDiff(r[dueKey]); return n < 0 ? `Overdue · ${r[dueKey]}` : n === 0 ? "Today" : n === 1 ? "Tomorrow" : r[dueKey]; };
  let acc = 0;
  const stops = names.filter((s) => cnt(s)).map((s) => { const from = (acc / total) * 100; acc += cnt(s); return `${colour(s)} ${from}% ${(acc / total) * 100}%`; }).join(",");
  const amount = money ? rows.reduce((sum, r) => sum + (+r[money.key] || 0), 0) : 0;
  return (
    <section className="card sum">
      <div className="row between"><h2>{title}</h2><button className="link" onClick={() => go(page)}>View all →</button></div>
      <div className="mini">
        {[["Total", total], ["Open", open.length], [doneLabel, total - open.length], ["Overdue", overdue]].map(([l, v]) => <div key={l}><b>{v}</b><small>{l}</small></div>)}
      </div>
      <div className="piewrap">
        <div className="pie" role="img" aria-label={`${title} by status`} style={{ background: total ? `conic-gradient(${stops})` : "#e5e7eb" }} />
        <ul className="legend">{names.map((s) => <li key={s}><i style={{ background: colour(s) }} />{s}<b>{cnt(s)}</b></li>)}</ul>
      </div>
      <p className="muted note">{money ? `${money.label}: ₹${Math.round(amount).toLocaleString("en-IN")}` : `${dueToday} due today`}</p>
      <h3 className="subhead">Due soon</h3>
      {soon.map((r) => (
        <div className="item" key={r.id}>
          <div><b>{label(r) || "—"}</b><small>{sub(r)}</small></div>
          <div className="right"><span className={"pill " + slug(r.status)}>{r.status || "—"}</span><small className={dayDiff(r[dueKey]) < 0 ? "late" : ""}>{when(r)}</small></div>
        </div>
      ))}
      {!soon.length && <p className="muted pad">Nothing due.</p>}
    </section>
  );
}
