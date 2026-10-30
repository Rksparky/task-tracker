"""Attendance (office geofence), trip tracking with petrol estimate, and the admin report."""
import json
import os
from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
from gspread.utils import rowcol_to_a1
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from auth import load_users
from store import tab

IST = timezone(timedelta(hours=5, minutes=30))
OFFICE = (float(os.getenv("OFFICE_LAT", "0")), float(os.getenv("OFFICE_LNG", "0")))
RADIUS = float(os.getenv("OFFICE_RADIUS_M", "150"))      # metres around the office
MAX_ACC = float(os.getenv("MAX_GPS_ACCURACY_M", "100"))  # reject weaker GPS fixes
KMPL = {"Bike": float(os.getenv("BIKE_KMPL", "45")), "Car": float(os.getenv("CAR_KMPL", "15"))}
PRICE = float(os.getenv("PETROL_PRICE", "100"))          # Rs per litre
A_HEAD = ["Date", "Username", "Name", "Time", "Distance from office (m)", "Latitude", "Longitude", "GPS accuracy (m)"]
T_HEAD = ["Date", "Username", "Name", "Vehicle", "Destination", "Started", "Ended", "Distance (km)", "Petrol (L)", "Petrol cost (Rs)", "Route"]
T_KEYS = ["date", "username", "name", "vehicle", "destination", "started", "ended", "km", "litres", "cost", "route"]
router = APIRouter()

def km(a, b):
    p1, p2 = radians(a[0]), radians(b[0])
    h = sin((p2 - p1) / 2) ** 2 + cos(p1) * cos(p2) * sin(radians(b[1] - a[1]) / 2) ** 2
    return 12742.0176 * asin(sqrt(h))

def now(): return datetime.now(IST)

def hm(iso):
    try: return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(IST).strftime("%H:%M")
    except Exception: return ""

def admin_only(request):
    if request.state.user["role"].lower() != "admin": raise HTTPException(403, "Admins only")

def gmap(r): return f"https://www.google.com/maps?q={r[5]},{r[6]}" if r and r[5] and r[6] else ""

def trip_row(r): return dict(zip(T_KEYS, r + [""] * (11 - len(r))))

class Loc(BaseModel):
    lat: float
    lng: float
    accuracy: float = 0

class Trip(BaseModel):
    vehicle: str = "Bike"
    destination: str = ""
    started: str = ""
    ended: str = ""
    points: list[list[float]]

def today_row(username):
    d = now().strftime("%d/%m/%Y")
    for r in tab("Attendance", A_HEAD).get_all_values()[1:]:
        if len(r) > 3 and r[0] == d and r[1].lower() == username.lower(): return r

@router.get("/api/attendance/today")
def attendance_today(request: Request):
    r = today_row(request.state.user["username"])
    return {"checked_in": bool(r), "time": r[3] if r else ""}

@router.post("/api/attendance")
def check_in(body: Loc, request: Request):
    """Always accepted: the place where the person marked attendance is recorded."""
    u = request.state.user
    r = today_row(u["username"])
    if r: return {"checked_in": True, "time": r[3], "message": f"Already marked present at {r[3]}."}
    d = round(km(OFFICE, (body.lat, body.lng)) * 1000) if OFFICE != (0.0, 0.0) else ""
    t = now()
    tab("Attendance", A_HEAD).append_row([t.strftime("%d/%m/%Y"), u["username"], u["name"], t.strftime("%H:%M:%S"),
                                          d, body.lat, body.lng, round(body.accuracy)], value_input_option="RAW")
    return {"checked_in": True, "time": t.strftime("%H:%M:%S"), "message": "Attendance marked and your location was recorded."}

def path_km(points):
    total, last = 0.0, None
    for p in points:
        if len(p) > 2 and p[2] > MAX_ACC: continue
        cur = (p[0], p[1])
        if last is None: last = cur; continue
        step = km(last, cur)
        if step >= 0.02: total += step; last = cur  # ignore GPS jitter under 20 m
    return total

@router.post("/api/trips", status_code=201)
def save_trip(body: Trip, request: Request):
    u = request.state.user
    if len(body.points) < 2 or any(len(p) < 2 for p in body.points): raise HTTPException(400, "Not enough GPS points were recorded.")
    if len(body.points) > 20000: raise HTTPException(400, "The trip has too many points.")
    d = path_km(body.points)
    vehicle = body.vehicle if body.vehicle in KMPL else "Bike"
    litres = d / KMPL[vehicle]; cost = litres * PRICE
    a, b = body.points[0], body.points[-1]
    link = f"https://www.google.com/maps/dir/?api=1&origin={a[0]},{a[1]}&destination={b[0]},{b[1]}"
    tab("Trips", T_HEAD).append_row([now().strftime("%d/%m/%Y"), u["username"], u["name"], vehicle, body.destination.strip()[:100],
                                     hm(body.started), now().strftime("%H:%M"), round(d, 2), round(litres, 2), round(cost, 2), link],
                                    value_input_option="RAW")
    return {"distance_km": round(d, 2), "petrol_l": round(litres, 2), "cost": round(cost, 2)}

@router.get("/api/trips")
def my_trips(request: Request):
    me = request.state.user["username"].lower()
    rows = [trip_row(r) for r in reversed(tab("Trips", T_HEAD).get_all_values()[1:]) if r and r[0] and r[1].lower() == me]
    return rows[:30]

@router.get("/api/admin/report")
def report(request: Request):
    admin_only(request)
    att = [r + [""] * (8 - len(r)) for r in tab("Attendance", A_HEAD).get_all_values()[1:] if r and r[0]]
    today = now().strftime("%d/%m/%Y")
    present = {r[1].lower(): r for r in att if r[0] == today}
    staff = [{"name": u["name"], "username": u["username"], "role": u["role"],
              "present": u["username"].lower() in present, "time": (present.get(u["username"].lower()) or [""] * 4)[3], "map": gmap(present.get(u["username"].lower()))}
             for u in load_users().values()]
    trips = [trip_row(r) for r in reversed(tab("Trips", T_HEAD).get_all_values()[1:]) if r and r[0]]
    return {"today": staff, "trips": trips[:200],
            "attendance": [{**dict(zip(["date", "username", "name", "time", "distance_m", "lat", "lng", "accuracy"], r)), "map": gmap(r)} for r in reversed(att)][:200]}


# ---------- Services and Projects ----------
KINDS = {
    "services": ("Services", "S", ["serial_no", "company", "contact", "channel_partner", "address", "contact_mobile", "contact_email",
                 "manager", "manager_mobile", "manager_email", "email_subject", "type", "generate_otp", "amount", "open_date",
                 "expected_closure", "problem_type", "problem", "status", "priority", "document_number", "branch", "service_type",
                 "service_amount", "description"]),
    "projects": ("Projects", "P", ["company", "contact", "channel_partner", "address", "contact_mobile", "contact_email", "manager",
                 "manager_mobile", "manager_email", "project_name", "source", "show_in_pdf", "source_details", "start_date",
                 "expected_end_date", "status", "priority", "document_number", "branch", "service_type", "project_cost", "description"]),
}
ACTION_KEYS = ["mode", "activity_type", "date", "time", "alert_unit", "alert_value", "actor", "notify_mobile", "mobile",
               "notify_email", "email", "instruction"]

class Record(BaseModel):
    data: dict[str, str] = {}
    action: dict[str, str] | None = None

def kind_of(kind):
    if kind not in KINDS: raise HTTPException(404, "Unknown page")
    return KINDS[kind]

def head(kind):
    return ["ID", "Created", "Created by"] + [k.replace("_", " ").title() for k in KINDS[kind][2]] + ["Schedule action"]

@router.get("/api/people")
def people():
    return [{"name": u["name"], "role": u["role"]} for u in load_users().values()]

@router.get("/api/records/{kind}")
def list_records(kind: str):
    name, _, keys = kind_of(kind)
    cols = ["id", "created", "created_by"] + keys + ["action"]
    out = []
    for r in reversed(tab(name, head(kind)).get_all_values()[1:]):
        if not r or not r[0]: continue
        d = dict(zip(cols, r + [""] * (len(cols) - len(r))))
        try: d["action"] = json.loads(d["action"]) if d["action"] else None
        except ValueError: d["action"] = None
        out.append(d)
    return out[:500]

def prepare(kind, body):
    _, _, keys = kind_of(kind)
    if not body.data.get("company", "").strip(): raise HTTPException(400, "Company is required")
    if kind == "projects" and not body.data.get("project_name", "").strip(): raise HTTPException(400, "Project name is required")
    vals = [body.data.get(k, "").strip()[:2000] for k in keys]
    act = json.dumps({k: body.action.get(k, "")[:500] for k in ACTION_KEYS}) if body.action else ""
    return vals, act

@router.post("/api/records/{kind}", status_code=201)
def add_record(kind: str, body: Record, request: Request):
    name, prefix, _ = kind_of(kind)
    u = request.state.user
    vals, act = prepare(kind, body)
    ws = tab(name, head(kind))
    rid = f"{prefix}-{len(ws.get_all_values()):04d}"
    ws.append_row([rid, now().strftime("%d/%m/%Y %H:%M"), u["name"]] + vals + [act], value_input_option="RAW")
    return {"id": rid}

@router.patch("/api/records/{kind}/{rid}")
def edit_record(kind: str, rid: str, body: Record):
    """Change a service/project, including its scheduled action. ID, Created and Created by stay as they were."""
    name, _, keys = kind_of(kind)
    vals, act = prepare(kind, body)
    ws = tab(name, head(kind))
    row = next((i for i, r in enumerate(ws.get_all_values(), 1) if i > 1 and r and r[0] == rid), None)
    if not row: raise HTTPException(404, "That record was not found. Refresh the page and try again.")
    ws.update(range_name=f"D{row}:{rowcol_to_a1(row, 3 + len(keys) + 1)}", values=[vals + [act]], value_input_option="RAW")
    return {"id": rid}
