"""Attendance (office geofence), trip tracking with petrol estimate, and the admin report."""
import os
from datetime import datetime, timedelta, timezone
from math import asin, cos, radians, sin, sqrt
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
    u = request.state.user
    if OFFICE == (0.0, 0.0): raise HTTPException(503, "The office location isn't set yet. Ask the admin.")
    r = today_row(u["username"])
    if r: return {"checked_in": True, "time": r[3], "message": f"Already marked present at {r[3]}."}
    if body.accuracy > MAX_ACC:
        raise HTTPException(400, f"Your GPS isn't accurate enough ({round(body.accuracy)} m). Move near a window or outdoors and try again.")
    d = km(OFFICE, (body.lat, body.lng)) * 1000
    if d > RADIUS:
        raise HTTPException(403, f"You are about {round(d)} m from the office. Attendance is only accepted within {round(RADIUS)} m.")
    t = now()
    tab("Attendance", A_HEAD).append_row([t.strftime("%d/%m/%Y"), u["username"], u["name"], t.strftime("%H:%M:%S"),
                                          round(d), body.lat, body.lng, round(body.accuracy)], value_input_option="RAW")
    return {"checked_in": True, "time": t.strftime("%H:%M:%S"), "message": "Attendance marked. Welcome!"}

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
    present = {r[1].lower(): r[3] for r in att if r[0] == today}
    staff = [{"name": u["name"], "username": u["username"], "role": u["role"],
              "present": u["username"].lower() in present, "time": present.get(u["username"].lower(), "")}
             for u in load_users().values()]
    trips = [trip_row(r) for r in reversed(tab("Trips", T_HEAD).get_all_values()[1:]) if r and r[0]]
    return {"today": staff, "trips": trips[:200],
            "attendance": [dict(zip(["date", "username", "name", "time", "distance_m"], r)) for r in reversed(att)][:200]}
