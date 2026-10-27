"""Task tracker API. Google Sheet = source of truth; PostgreSQL = fast mirror.
Sheet -> DB: a background thread re-reads the sheet every SYNC_SECONDS.
Website -> Sheet: every edit is written to the sheet first, then re-synced to the DB."""
from dotenv import load_dotenv
load_dotenv()
import json, os, threading, time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import gspread
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from gspread.utils import rowcol_to_a1
from pydantic import BaseModel
from sqlalchemy import Column, Integer, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

SHEET_ID = os.environ["GOOGLE_SHEET_ID"]
TAB = os.getenv("SHEET_NAME") or None
SYNC_SECONDS = float(os.getenv("SYNC_SECONDS", "5"))  # Sheets API allows ~60 reads/min
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./tasks.db")

# API field -> sheet header
FIELDS = {"date": "Date", "assigned_by": "Assigned By", "assigned_to": "Assigned To",
          "task": "Task Message", "deadline": "Deadline", "status": "Status",
          "work_update": "Work Update", "to_tg": "Assigned To Telegram ID",
          "by_tg": "Assigned By Telegram ID"}

Base = declarative_base()
class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True)  # = sheet row number
    date = Column(Text); assigned_by = Column(Text); assigned_to = Column(Text)
    task = Column(Text); deadline = Column(Text); status = Column(Text)
    work_update = Column(Text); to_tg = Column(Text); by_tg = Column(Text)

engine = create_engine(DB_URL)
Session = sessionmaker(engine)
lock = threading.RLock()
_last, version, _ws = None, 0, None

def worksheet():
    global _ws
    if _ws is None:
        blob = os.getenv("GOOGLE_CREDENTIALS_JSON")
        gc = (gspread.service_account_from_dict(json.loads(blob)) if blob
              else gspread.service_account(filename=os.getenv("GOOGLE_CREDENTIALS_FILE", "service_account.json")))
        sh = gc.open_by_key(SHEET_ID)
        _ws = sh.worksheet(TAB) if TAB else sh.sheet1
    return _ws

def columns(header):  # header name -> 1-based column (first occurrence wins)
    cols = {}
    for i, h in enumerate(header, 1):
        h = h.strip()
        if h and h not in cols: cols[h] = i
    return cols

def read_sheet():
    values = worksheet().get_all_values()
    if not values: return []
    cols, rows = columns(values[0]), []
    for r, line in enumerate(values[1:], start=2):
        get = lambda h: line[cols[h] - 1].strip() if h in cols and cols[h] <= len(line) else ""
        row = {f: get(h) for f, h in FIELDS.items()}
        if row["task"]: rows.append({"id": r, **row})  # skips blank rows
    return rows

def sync():
    global _last, version
    with lock:
        try: rows = read_sheet()
        except Exception: return  # network/quota hiccup; retry on next tick
        if rows == _last: return
        with Session() as s:
            s.query(Task).delete(); s.add_all(Task(**r) for r in rows); s.commit()
        _last = rows; version += 1

def watcher():
    while True:
        sync(); time.sleep(SYNC_SECONDS)

def write_sheet(fn):
    with lock:
        try:
            ws = worksheet(); result = fn(ws, columns(ws.row_values(1)))
        except HTTPException: raise
        except Exception as e:
            raise HTTPException(502, f"Google Sheets error: {e}")
    sync()
    return result

def set_cells(ws, cols, row, values):
    data = [{"range": rowcol_to_a1(row, cols[FIELDS[f]]), "values": [[v]]}
            for f, v in values.items() if FIELDS[f] in cols]
    if data: ws.batch_update(data, value_input_option="RAW")  # RAW keeps text exactly as typed

def check_row(ws, cols, r):
    if r < 2 or not ws.cell(r, cols["Task Message"]).value:
        raise HTTPException(404, "Task not found. The sheet may have changed; refresh.")

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine); sync()
    threading.Thread(target=watcher, daemon=True).start()
    yield

app = FastAPI(title="Task Tracker", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])

class TaskIn(BaseModel):
    assigned_by: str = ""; assigned_to: str = ""; task: str; deadline: str = ""
    status: str = "Pending"; work_update: str = ""

class TaskPatch(BaseModel):
    assigned_by: Optional[str] = None; assigned_to: Optional[str] = None
    task: Optional[str] = None; deadline: Optional[str] = None
    status: Optional[str] = None; work_update: Optional[str] = None

@app.get("/api/version")
def get_version(): return {"version": version}

@app.get("/api/tasks")
def list_tasks():
    with Session() as s:
        return [{"id": t.id, **{f: getattr(t, f) for f in FIELDS}} for t in s.query(Task).order_by(Task.id.desc())]

@app.post("/api/tasks", status_code=201)
def create_task(body: TaskIn):
    values = {**body.model_dump(), "date": datetime.now().strftime("%m/%d/%Y %H:%M:%S")}
    def add(ws, cols):
        col = ws.col_values(cols["Task Message"])  # position of last non-empty task
        last = max([i for i, v in enumerate(col, 1) if v.strip()] + [1])
        r = last + 1
        if r > ws.row_count: ws.add_rows(1)
        set_cells(ws, cols, r, values)
        return r
    return {"id": write_sheet(add)}

@app.patch("/api/tasks/{row}")
def update_task(row: int, body: TaskPatch):
    changes = body.model_dump(exclude_none=True)
    def edit(ws, cols): check_row(ws, cols, row); set_cells(ws, cols, row, changes)
    write_sheet(edit); return {"ok": True}

@app.delete("/api/tasks/{row}")
def delete_task(row: int):
    def rm(ws, cols): check_row(ws, cols, row); ws.delete_rows(row)
    write_sheet(rm); return {"ok": True}
