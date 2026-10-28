import { useEffect, useState } from "react";

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
        <div className="brand"><span className="logo">✓</span>GVR Tasks</div>
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
  const save = (e) => {
    e.preventDefault();
    const { id, ...body } = form;
    if (id) patch(id, body); else act(() => api("/api/tasks", { method: "POST", body: JSON.stringify(body) }));
    setForm(null);
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const nav = [["dashboard", "Dashboard"], ["tasks", "Tasks"], ["profile", "Profile"]];

  return (
    <div className="app">
      <aside>
        <div className="brand"><span className="logo">✓</span>GVR Tasks</div>
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
        {page === "tasks" && <Tasks tasks={tasks} patch={patch} act={act} open={(t) => setForm(t || { ...EMPTY, assigned_by: user.name })} />}
        {page === "profile" && <Profile user={user} tasks={tasks} logout={logout} />}
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
            <div className="row end"><button type="button" onClick={() => setForm(null)}>Cancel</button><button className="primary">{form.id ? "Save changes" : "Add task"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function Dashboard({ user, tasks, go }) {
  const open = tasks.filter((t) => t.status !== "Completed");
  const overdue = open.filter((t) => dayDiff(t.deadline) < 0).length;
  const dueToday = open.filter((t) => dayDiff(t.deadline) === 0).length;
  const upcoming = open.filter((t) => parseD(t.deadline)).sort((a, b) => parseD(a.deadline) - parseD(b.deadline)).slice(0, 5);
  const total = tasks.length;
  let acc = 0;
  const stops = STATUSES.map((s) => { const from = (acc / total) * 100; acc += count(tasks, s); return `${COLORS[s]} ${from}% ${(acc / total) * 100}%`; }).join(",");
  const cards = [
    ["Total tasks", total, `${dueToday} due today`],
    ["Pending", count(tasks, "Pending"), `${overdue} overdue`],
    ["In progress", count(tasks, "In Progress"), "being worked on"],
    ["Completed", count(tasks, "Completed"), total ? `${Math.round((count(tasks, "Completed") / total) * 100)}% done` : "—"],
  ];
  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">Welcome back, {user.name.split(" ")[0]}. Here's what's happening with your work today.</p>
      <div className="stats">{cards.map(([l, n, s]) => <div className="card stat" key={l}><span className="muted">{l}</span><b>{n}</b><small>{s}</small></div>)}</div>
      <div className="grid2">
        <section className="card">
          <div className="row between"><h2>Upcoming tasks</h2><button className="link" onClick={() => go("tasks")}>View all →</button></div>
          {upcoming.map((t) => (
            <div className="item" key={t.id}>
              <div><b>{t.task}</b><small>{t.assigned_to}</small></div>
              <div className="right"><span className={"pill " + slug(t.status)}>{t.status}</span><small>{dueLabel(t)}</small></div>
            </div>
          ))}
          {!upcoming.length && <p className="muted pad">Nothing due soon.</p>}
        </section>
        <section className="card">
          <h2>Quick view</h2>
          <div className="donutwrap">
            <div className="donut" style={{ background: total ? `conic-gradient(${stops})` : "#e5e7eb" }}><div><b>{total}</b><small>Total tasks</small></div></div>
            <ul className="legend">{STATUSES.map((s) => <li key={s}><i style={{ background: COLORS[s] }} />{s}<b>{count(tasks, s)}</b></li>)}</ul>
          </div>
        </section>
      </div>
    </>
  );
}

function Tasks({ tasks, patch, act, open }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("All");
  const shown = tasks.filter((t) => (tab === "All" || t.status === tab) && `${t.task} ${t.assigned_to} ${t.assigned_by} ${t.work_update}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="row between wrap">
        <div><h1>Tasks</h1><p className="muted">Manage your tasks and stay on track.</p></div>
        <div className="row"><input className="search" placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="primary" onClick={() => open()}>+ Add task</button></div>
      </div>
      <div className="tabs">{["All", ...STATUSES].map((s) => <button key={s} className={tab === s ? "tab active" : "tab"} onClick={() => setTab(s)}>{s} ({s === "All" ? tasks.length : count(tasks, s)})</button>)}</div>
      <div className="card scroll">
        <table>
          <thead><tr><th>Title</th><th>Assigned to</th><th>Assigned by</th><th>Due</th><th>Status</th><th /></tr></thead>
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
      <section className="card">
        <h2>My open tasks</h2>
        {mine.filter((t) => t.status !== "Completed").map((t) => <div className="item" key={t.id}><b>{t.task}</b><div className="right"><span className={"pill " + slug(t.status)}>{t.status}</span><small>{dueLabel(t)}</small></div></div>)}
        {!mine.some((t) => t.status !== "Completed") && <p className="muted pad">No open tasks. Tasks are matched by your name in "Assigned to".</p>}
      </section>
    </>
  );
}
