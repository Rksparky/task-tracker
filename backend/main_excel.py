"""Task tracker API. Excel is the source of truth; PostgreSQL is a fast mirror of it.
Excel -> DB: a watcher thread re-reads the file whenever it changes.
Frontend -> Excel: every edit is written to the .xlsx first, then re-synced to the DB."""
import os, threading, time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openpyxl import Workbook, load_workbook
from pydantic import BaseModel
from sqlalchemy import Column, Integer, Text, create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

XLSX = os.getenv("EXCEL_PATH", "./tasks.xlsx")
SHEET = os.getenv("SHEET_NAME") or None
DB_URL = os.getenv("DATABASE_URL", "sqlite:///./tasks.db")  # set to Postgres in .env

# API field -> Excel header
FIELDS = {"date": "Date", "assigned_by": "Assigned By", "assigned_to": "Assigned To",
          "task": "Task Message", "deadline": "Deadline", "status": "Status",
          "work_update": "Work Update", "to_tg": "Assigned To Telegram ID",
          "by_tg": "Assigned By Telegram ID"}

Base = declarative_base()
class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True)  # = Excel row number
    date = Column(Text); assigned_by = Column(Text); assigned_to = Column(Text)
    task = Column(Text); deadline = Column(Text); status = Column(Text)
    work_update = Column(Text); to_tg = Column(Text); by_tg = Column(Text)

engine = create_engine(DB_URL)
Session = sessionmaker(engine)
lock = threading.RLock()
_last, version = None, 0

def sheet(wb): return wb[SHEET] if SHEET else wb.active

def columns(ws):  # header name -> column index (first occurrence wins)
    cols = {}
    for c in range(1, ws.max_column + 1):
        h = str(ws.cell(1, c).value or "").strip()
        if h and h not in cols: cols[h] = c
    return cols

def cell_str(v):
    if v is None: return ""
    if isinstance(v, datetime):
        return v.strftime("%d/%m/%Y %H:%M:%S" if (v.hour or v.minute or v.second) else "%d/%m/%Y")
    return str(v).strip()

def read_excel():
    wb = load_workbook(XLSX, data_only=True)
    ws = sheet(wb); cols = columns(ws); rows = []
    for r in range(2, ws.max_row + 1):
        row = {f: cell_str(ws.cell(r, cols[h]).value) if h in cols else "" for f, h in FIELDS.items()}
        if row["task"]: rows.append({"id": r, **row})  # skips blank rows
    wb.close()
    return rows

def sync():
    global _last, version
    with lock:
        try: rows = read_excel()
        except OSError: return  # file busy (open in Excel); retry on next tick
        if rows == _last: return
        with Session() as s:
            s.query(Task).delete(); s.add_all(Task(**r) for r in rows); s.commit()
        _last = rows; version += 1

def watcher():
    seen = None
    while True:
        try:
            m = os.path.getmtime(XLSX)
            if m != seen: seen = m; sync()
        except OSError: pass
        time.sleep(1)

def write_excel(fn):
    with lock:
        try:
            wb = load_workbook(XLSX); ws = sheet(wb)
            result = fn(ws, columns(ws)); wb.save(XLSX)
        except PermissionError:
            raise HTTPException(423, "The Excel file is open in another program. Close it and try again.")
    sync()
    return result

def check_row(ws, cols, r):
    if r < 2 or not ws.cell(r, cols["Task Message"]).value:
        raise HTTPException(404, "Task not found. The sheet may have changed; refresh.")

@asynccontextmanager
async def lifespan(app):
    if not os.path.exists(XLSX):  # first run: create an empty sheet with the right headers
        wb = Workbook(); wb.active.append(list(FIELDS.values())); wb.save(XLSX)
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
        r = 1
        for i in range(2, ws.max_row + 1):
            if ws.cell(i, cols["Task Message"]).value: r = i
        r += 1
        for f, v in values.items():
            if FIELDS[f] in cols: ws.cell(r, cols[FIELDS[f]], v)
        return r
    return {"id": write_excel(add)}

@app.patch("/api/tasks/{row}")
def update_task(row: int, body: TaskPatch):
    changes = body.model_dump(exclude_none=True)
    def edit(ws, cols):
        check_row(ws, cols, row)
        for f, v in changes.items():
            if FIELDS[f] in cols: ws.cell(row, cols[FIELDS[f]], v)
    write_excel(edit); return {"ok": True}

@app.delete("/api/tasks/{row}")
def delete_task(row: int):
    def rm(ws, cols): check_row(ws, cols, row); ws.delete_rows(row)
    write_excel(rm); return {"ok": True}
