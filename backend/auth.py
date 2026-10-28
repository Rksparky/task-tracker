"""Login for GVR Tasks. Users come from the USERS env var; tokens are signed with SECRET_KEY.
USERS format:  username:password:Display Name:Role,username2:password2:Display Name 2:Role
(avoid ':' and ',' inside passwords)"""
import base64, hashlib, hmac, json, os, time
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

SECRET = os.getenv("SECRET_KEY", "")
if not SECRET:
    raise RuntimeError("Set the SECRET_KEY environment variable (any long random text).")
PUBLIC = {"/api/login", "/api/version"}
TTL = 60 * 60 * 12  # stay logged in for 12 hours

def load_users():
    users = {}
    for item in os.getenv("USERS", "").split(","):
        p = [x.strip() for x in item.split(":")]
        if len(p) >= 2 and p[0]:
            users[p[0].lower()] = {"username": p[0], "password": p[1],
                                   "name": p[2] if len(p) > 2 and p[2] else p[0],
                                   "role": p[3] if len(p) > 3 and p[3] else "Member"}
    return users

def public(u): return {k: u[k] for k in ("username", "name", "role")}

def _sig(body): return hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()

def sign(data):
    body = base64.urlsafe_b64encode(json.dumps(data).encode()).decode()
    return f"{body}.{_sig(body)}"

def verify(token):
    try:
        body, sig = token.split(".")
        if not hmac.compare_digest(sig, _sig(body)): return None
        data = json.loads(base64.urlsafe_b64decode(body))
        return data if data["exp"] > time.time() else None
    except Exception:
        return None

router = APIRouter()

class Login(BaseModel):
    username: str
    password: str

@router.post("/api/login")
def login(body: Login):
    u = load_users().get(body.username.strip().lower())
    if not u or not hmac.compare_digest(u["password"].encode(), body.password.encode()):
        time.sleep(0.5)  # slows down password guessing
        raise HTTPException(401, "Wrong username or password")
    return {"token": sign({"u": u["username"], "exp": time.time() + TTL}), "user": public(u)}

@router.get("/api/me")
def me(request: Request): return public(request.state.user)

def install_auth(app):
    """Call BEFORE adding CORSMiddleware so CORS headers also cover 401 replies."""
    app.include_router(router)
    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path not in PUBLIC and request.method != "OPTIONS":
            data = verify(request.headers.get("authorization", "").removeprefix("Bearer "))
            user = load_users().get(data["u"].lower()) if data else None
            if not user: return JSONResponse({"detail": "Please log in again"}, status_code=401)
            request.state.user = user
        return await call_next(request)
