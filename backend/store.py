"""Extra Google Sheet tabs (Passwords, Attendance, Trips). Tabs are created automatically."""
import hashlib, hmac, json, os, secrets, threading
from datetime import datetime
import gspread

lock = threading.RLock()
_sh, _tabs, _pw = None, {}, None
PW_HEAD = ["Username", "Password hash", "Updated"]

def spreadsheet():
    global _sh
    if _sh is None:
        blob = os.getenv("GOOGLE_CREDENTIALS_JSON")
        gc = (gspread.service_account_from_dict(json.loads(blob)) if blob
              else gspread.service_account(filename=os.getenv("GOOGLE_CREDENTIALS_FILE", "service_account.json")))
        _sh = gc.open_by_key(os.environ["GOOGLE_SHEET_ID"])
    return _sh

def tab(name, headers):
    with lock:
        if name not in _tabs:
            sh = spreadsheet()
            try: ws = sh.worksheet(name)
            except gspread.WorksheetNotFound:
                ws = sh.add_worksheet(name, rows=1000, cols=len(headers))
                ws.append_row(headers, value_input_option="RAW")
            _tabs[name] = ws
        return _tabs[name]

def _passwords():
    global _pw
    with lock:
        if _pw is None:
            rows = tab("Passwords", PW_HEAD).get_all_values()[1:]
            _pw = {r[0].strip().lower(): r[1] for r in rows if len(r) > 1 and r[0].strip()}
        return _pw

def _hash(password, salt):
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()

def check_password(user, password):
    """Changed passwords live (hashed) in the Passwords tab; otherwise the one from USERS is used."""
    stored = _passwords().get(user["username"].lower())
    if stored: return hmac.compare_digest(_hash(password, stored.split("$")[0]), stored)
    return hmac.compare_digest(user["password"].encode(), password.encode())

def set_password(username, new):
    with lock:
        pws = _passwords(); ws = tab("Passwords", PW_HEAD)
        h, when = _hash(new, secrets.token_hex(8)), datetime.now().isoformat(timespec="seconds")
        for i, r in enumerate(ws.get_all_values()[1:], start=2):
            if r and r[0].strip().lower() == username.lower():
                ws.update(range_name=f"B{i}:C{i}", values=[[h, when]]); break
        else:
            ws.append_row([username, h, when], value_input_option="RAW")
        pws[username.lower()] = h
