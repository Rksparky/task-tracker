import { useState } from "react";

/* Ticket flow for Services assigned to me:
   1. Activity form (stage Open / Closed / Revisit)  ->  [Next Activity] or [Close]
   2. Next Activity: schedule the follow-up            ->  Save Action
   3. Close: closure details                           ->  Save Action                       */

const pad = (n) => String(n).padStart(2, "0");
const todayDMY = () => { const d = new Date(); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toISO = (s) => { const m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : ""; };
const toDMY = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const yn = (b) => (b ? "Yes" : "No");

const MODES = [["Visit", "👤"], ["Email", "✉️"], ["Call", "📞"], ["Online", "🖥️"]];
const ACTIVITY = ["Fault", "Installation", "Maintenance", "Follow-up", "Meeting", "Payment"];
const STAGES = ["Open", "Closed", "Revisit"];
const PRIORITY = ["Low", "Normal", "High", "Urgent"];
const WORK_TYPES = ["Fault", "Installation", "Maintenance", "Other"];
const TICKET_TYPES = ["Chargeable", "Non-chargeable", "Warranty", "AMC"];
const CLOSE_STATUS = ["Complete", "Incomplete", "Cancelled"];

function Modes({ value, onChange }) {
  return (
    <div className="modes">
      {MODES.map(([m, i]) => (
        <label key={m} className="mode"><input type="radio" name="flowmode" checked={value === m} onChange={() => onChange(m)} />{i} {m}</label>
      ))}
    </div>
  );
}

function Sel({ label, value, onChange, options }) {
  return <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></label>;
}

function Contact({ label, ticket, name, other, setName, setOther }) {
  return (
    <div className="two">
      <label>{label}
        {other
          ? <input value={name} placeholder="Type contact name" onChange={(e) => setName(e.target.value)} />
          : <select value={name} onChange={(e) => setName(e.target.value)}>{[ticket.contact].filter(Boolean).map((o) => <option key={o}>{o}</option>)}{!ticket.contact && <option value="">—</option>}</select>}
      </label>
      <label className="chk"><input type="checkbox" checked={other} onChange={(e) => { setOther(e.target.checked); setName(e.target.checked ? "" : ticket.contact || ""); }} />Other</label>
    </div>
  );
}

function Notify({ label, checked, setChecked, value, setValue, type = "text" }) {
  return (
    <div className="notify">
      <input type="checkbox" aria-label={`Send ${label}`} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
      <label>{label}<input type={type} value={value} onChange={(e) => setValue(e.target.value)} /></label>
    </div>
  );
}

export default function ActivityFlow({ ticket, user, people, api, onClose, onDone }) {
  const [step, setStep] = useState("log");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // step 1: the activity being logged now
  const [log, setLog] = useState({
    mode: "Visit", activity_type: ticket.problem_type || "Fault", stage: "Open", discussion: "",
    from_date: todayDMY(), from_time: nowHM(), to_date: todayDMY(), to_time: nowHM(),
    contact: ticket.contact || "", activity_by: user.name, money: "", dcr_no: "", kms: "0", claim_kms: false, email_report: false,
  });
  const [logOther, setLogOther] = useState(false);
  const L = (k) => (v) => setLog((s) => ({ ...s, [k]: v }));

  // step 2: the follow-up activity
  const [nx, setNx] = useState({
    mode: "Visit", activity_type: ticket.problem_type || "Fault", date: todayDMY(), time: nowHM(), alert_value: "1", alert_unit: "Hours",
    customer_contact: ticket.contact || "", customer_sms: false, customer_email: false, instruction: "",
    actor: user.name, notify_mobile: false, mobile: "", notify_email: false, email: "",
  });
  const [nxOther, setNxOther] = useState(false);
  const N = (k) => (v) => setNx((s) => ({ ...s, [k]: v }));

  // step 3: closure
  const [cl, setCl] = useState({
    status: "Complete", otp: "", work_type: ticket.problem_type || "Fault", priority: ticket.priority || "Normal", ticket_type: ticket.type || "Chargeable",
    spare_used: "", spare_cost: "", remark: "", contact: ticket.contact || "", customer_sms: false, customer_email: false,
    manage_by: ticket.manager || user.name, notify_mobile: false, mobile: ticket.manager_mobile || "", notify_email: false, email: ticket.manager_email || "",
  });
  const [clOther, setClOther] = useState(false);
  const C = (k) => (v) => setCl((s) => ({ ...s, [k]: v }));

  const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "boolean" ? yn(v) : String(v ?? "")]));
  const send = async (which) => {
    setBusy(true); setErr("");
    try {
      await api(`/api/records/services/${ticket.id}/activity`, {
        method: "POST",
        body: JSON.stringify({ step: which, log: flat(log), next: which === "next" ? flat(nx) : {}, close: which === "close" ? flat(cl) : {} }),
      });
      onDone();
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };

  const needDiscussion = () => {
    if (!log.discussion.trim()) { setErr("Enter the discussion / work done first."); return false; }
    setErr(""); return true;
  };
  const go = (to) => () => { if (needDiscussion()) setStep(to); };
  const who = people.includes(user.name) ? people : [user.name, ...people];

  return (
    <div className="overlay top" onClick={onClose}>
      <div className="modal card flow" onClick={(e) => e.stopPropagation()}>
        <div className="titlebar">
          <h2>{ticket.id} · {ticket.company}{ticket.problem ? ` · ${ticket.problem}` : ""}</h2>
          <button type="button" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        {step === "log" && (
          <>
            <Modes value={log.mode} onChange={L("mode")} />
            <div className="two">
              <Sel label="Activity type" value={log.activity_type} onChange={L("activity_type")} options={ACTIVITY} />
              <Sel label="Move to stage" value={log.stage} onChange={L("stage")} options={STAGES} />
            </div>
            <label>Discussion / work done<textarea rows="3" value={log.discussion} onChange={(e) => L("discussion")(e.target.value)} /></label>
            <div className="two">
              <label>From date<input type="date" value={toISO(log.from_date)} onChange={(e) => L("from_date")(toDMY(e.target.value))} /></label>
              <label>From time<input type="time" value={log.from_time} onChange={(e) => L("from_time")(e.target.value)} /></label>
              <label>To date<input type="date" value={toISO(log.to_date)} onChange={(e) => L("to_date")(toDMY(e.target.value))} /></label>
              <label>To time<input type="time" value={log.to_time} onChange={(e) => L("to_time")(e.target.value)} /></label>
            </div>
            <Contact label="Contact name" ticket={ticket} name={log.contact} other={logOther} setName={L("contact")} setOther={setLogOther} />
            <div className="two">
              <label>Activity by<select value={log.activity_by} onChange={(e) => L("activity_by")(e.target.value)}>{who.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Money<input type="number" min="0" value={log.money} onChange={(e) => L("money")(e.target.value)} /></label>
              <label>DCR no<input value={log.dcr_no} onChange={(e) => L("dcr_no")(e.target.value)} /></label>
              <label>KMS<input type="number" min="0" value={log.kms} onChange={(e) => L("kms")(e.target.value)} /></label>
            </div>
            <div className="row wrap">
              <label className="chk"><input type="checkbox" checked={log.claim_kms} onChange={(e) => L("claim_kms")(e.target.checked)} />Claim KMS</label>
              <label className="chk"><input type="checkbox" checked={log.email_report} onChange={(e) => L("email_report")(e.target.checked)} />Email report</label>
            </div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="row between">
              <button type="button" onClick={go("close")}>Close</button>
              <button type="button" className="primary" onClick={go("next")}>Next Activity</button>
            </div>
          </>
        )}

        {step === "next" && (
          <>
            <Modes value={nx.mode} onChange={N("mode")} />
            <div className="two">
              <Sel label="Activity type" value={nx.activity_type} onChange={N("activity_type")} options={ACTIVITY} />
              <div className="two">
                <label>On date<input type="date" value={toISO(nx.date)} onChange={(e) => N("date")(toDMY(e.target.value))} /></label>
                <label>Time<input type="time" value={nx.time} onChange={(e) => N("time")(e.target.value)} /></label>
              </div>
              <Sel label="Alert before" value={nx.alert_unit} onChange={N("alert_unit")} options={["Minutes", "Hours", "Days"]} />
              <Sel label="How many" value={nx.alert_value} onChange={N("alert_value")} options={["1", "2", "3", "4", "5", "6", "12", "24"]} />
            </div>
            <Contact label="Customer contact name" ticket={ticket} name={nx.customer_contact} other={nxOther} setName={N("customer_contact")} setOther={setNxOther} />
            <div className="row wrap">
              <label className="chk"><input type="checkbox" checked={nx.customer_sms} onChange={(e) => N("customer_sms")(e.target.checked)} />SMS customer</label>
              <label className="chk"><input type="checkbox" checked={nx.customer_email} onChange={(e) => N("customer_email")(e.target.checked)} />Email customer</label>
            </div>
            <label>Instruction<textarea rows="3" value={nx.instruction} onChange={(e) => N("instruction")(e.target.value)} /></label>
            <label>Activity by<select value={nx.actor} onChange={(e) => N("actor")(e.target.value)}>{who.map((p) => <option key={p}>{p}</option>)}</select></label>
            <div className="two">
              <Notify label="SMS" checked={nx.notify_mobile} setChecked={N("notify_mobile")} value={nx.mobile} setValue={N("mobile")} />
              <Notify label="Email" type="email" checked={nx.notify_email} setChecked={N("notify_email")} value={nx.email} setValue={N("email")} />
            </div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="row between">
              <button type="button" onClick={() => { setErr(""); setStep("log"); }}>Back</button>
              <button type="button" className="primary" disabled={busy} onClick={() => send("next")}>{busy ? "Saving…" : "Save Action"}</button>
            </div>
          </>
        )}

        {step === "close" && (
          <>
            <div className="two">
              <Sel label="Select status" value={cl.status} onChange={C("status")} options={CLOSE_STATUS} />
              <label>Select OTP<input value={cl.otp} onChange={(e) => C("otp")(e.target.value)} /></label>
              <Sel label="Work type" value={cl.work_type} onChange={C("work_type")} options={WORK_TYPES} />
              <Sel label="Priority type" value={cl.priority} onChange={C("priority")} options={PRIORITY} />
              <Sel label="Ticket type" value={cl.ticket_type} onChange={C("ticket_type")} options={TICKET_TYPES} />
              <span />
              <label>Spare used<input value={cl.spare_used} onChange={(e) => C("spare_used")(e.target.value)} /></label>
              <label>Spare cost<input type="number" min="0" value={cl.spare_cost} onChange={(e) => C("spare_cost")(e.target.value)} /></label>
            </div>
            <label>Remark<textarea rows="3" value={cl.remark} onChange={(e) => C("remark")(e.target.value)} /></label>
            <Contact label="Contact name" ticket={ticket} name={cl.contact} other={clOther} setName={C("contact")} setOther={setClOther} />
            <div className="row wrap">
              <label className="chk"><input type="checkbox" checked={cl.customer_sms} onChange={(e) => C("customer_sms")(e.target.checked)} />SMS customer</label>
              <label className="chk"><input type="checkbox" checked={cl.customer_email} onChange={(e) => C("customer_email")(e.target.checked)} />Email customer</label>
            </div>
            <label>Manage by<select value={cl.manage_by} onChange={(e) => C("manage_by")(e.target.value)}>{(who.includes(cl.manage_by) ? who : [cl.manage_by, ...who]).map((p) => <option key={p}>{p}</option>)}</select></label>
            <div className="two">
              <Notify label="SMS" checked={cl.notify_mobile} setChecked={C("notify_mobile")} value={cl.mobile} setValue={C("mobile")} />
              <Notify label="Email" type="email" checked={cl.notify_email} setChecked={C("notify_email")} value={cl.email} setValue={C("email")} />
            </div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="row between">
              <button type="button" onClick={() => { setErr(""); setStep("log"); }}>Back</button>
              <button type="button" className="primary" disabled={busy} onClick={() => send("close")}>{busy ? "Saving…" : "Save Action"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
