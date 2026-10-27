import { useEffect, useMemo, useState } from "react";

const API = import.meta.env.VITE_API || "http://localhost:8000";
const STATUSES = ["Pending", "In Progress", "Completed"];
const EMPTY = { assigned_by: "", assigned_to: "", task: "", deadline: "", status: "Pending", work_update: "" };

async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Request failed");
  return r.json();
}

// Progress = last "NN%" in the work update; 100 when completed.
function progress(t) {
  if (t.status === "Completed") return 100;
  const m = [...(t.work_update || "").matchAll(/(\d+)\s*%/g)];
  return m.length ? Math.min(100, +m[m.length - 1][1]) : 0;
}
const slug = (s) => (s || "pending").toLowerCase().replace(/\s+/g, "-");

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [live, setLive] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [person, setPerson] = useState("All");
  const [status, setStatus] = useState("All");
  const [form, setForm] = useState(null); // null = closed

  const reload = async () => setTasks(await api("/api/tasks"));

  // Poll a tiny version endpoint; refetch only when Excel/DB data changed.
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

  const act = async (fn) => {
    try { setError(""); await fn(); await reload(); } catch (e) { setError(e.message); }
  };
  const patch = (id, body) => act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }));

  const people = useMemo(() => ["All", ...new Set(tasks.map((t) => t.assigned_to).filter(Boolean))], [tasks]);
  const shown = tasks.filter(
    (t) =>
      (person === "All" || t.assigned_to === person) &&
      (status === "All" || t.status === status) &&
      `${t.task} ${t.assigned_to} ${t.assigned_by} ${t.work_update}`.toLowerCase().includes(q.toLowerCase())
  );
  const count = (s) => tasks.filter((t) => t.status === s).length;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = (e) => {
    e.preventDefault();
    const { id, ...body } = form;
    if (id) patch(id, body);
    else act(() => api("/api/tasks", { method: "POST", body: JSON.stringify(body) }));
    setForm(null);
  };

  return (
    <main>
      <header>
        <div>
          <h1>Team tasks</h1>
          <p className="sub">
            <span className={"dot " + (live ? "on" : "off")} />
            {live ? "Synced with Google Sheets" : "Can't reach the server"} · {tasks.length} tasks · {count("Completed")} completed
          </p>
        </div>
        <button className="primary" onClick={() => setForm({ ...EMPTY })}>Add task</button>
      </header>

      <div className="tools">
        <input placeholder="Search tasks, people, updates" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          {people.map((p) => (
            <button key={p} className={person === p ? "chip active" : "chip"} onClick={() => setPerson(p)}>{p}</button>
          ))}
        </div>
        <div className="chips">
          {["All", ...STATUSES].map((s) => (
            <button key={s} className={status === s ? "chip active" : "chip"} onClick={() => setStatus(s)}>
              {s}{s !== "All" && ` (${count(s)})`}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <section className="list">
        {shown.map((t) => (
          <article key={t.id} className={"task " + slug(t.status)}>
            <div>
              <h2>{t.task}</h2>
              <p className="meta">{t.assigned_by} assigned to <b>{t.assigned_to}</b> · due {t.deadline || "no deadline"}</p>
              {t.work_update && <pre className="update">{t.work_update}</pre>}
              <div className="bar" aria-label={`${progress(t)}% done`}><i style={{ width: progress(t) + "%" }} /></div>
            </div>
            <div className="side">
              <select value={t.status} aria-label="Status" onChange={(e) => patch(t.id, { status: e.target.value })}>
                {[...new Set([...STATUSES, t.status])].map((s) => <option key={s}>{s}</option>)}
              </select>
              <small>{t.date}</small>
              <div className="actions">
                <button onClick={() => setForm({ id: t.id, assigned_by: t.assigned_by, assigned_to: t.assigned_to, task: t.task, deadline: t.deadline, status: t.status, work_update: t.work_update })}>Edit</button>
                <button className="danger" onClick={() => confirm("Delete this task from the Google Sheet?") && act(() => api(`/api/tasks/${t.id}`, { method: "DELETE" }))}>Delete</button>
              </div>
            </div>
          </article>
        ))}
        {!shown.length && <p className="empty">No tasks match. Add one, or add a row in the Google Sheet.</p>}
      </section>

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{form.id ? "Edit task" : "Add task"}</h2>
            <label>Task<input required value={form.task} onChange={set("task")} /></label>
            <div className="two">
              <label>Assigned by<input value={form.assigned_by} onChange={set("assigned_by")} /></label>
              <label>Assigned to<input value={form.assigned_to} onChange={set("assigned_to")} /></label>
              <label>Deadline<input placeholder="dd/mm/yyyy" value={form.deadline} onChange={set("deadline")} /></label>
              <label>Status
                <select value={form.status} onChange={set("status")}>
                  {[...new Set([...STATUSES, form.status])].map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <label>Work update<textarea rows="4" value={form.work_update} onChange={set("work_update")} /></label>
            <div className="actions end">
              <button type="button" onClick={() => setForm(null)}>Cancel</button>
              <button className="primary">Save changes</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
