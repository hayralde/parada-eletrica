"""
API Parada Elétrica – Acompanhamento em tempo real
"""
from fastapi import FastAPI, Depends, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional, Set
from datetime import datetime
import json
import os
from pathlib import Path

from database import init_db, get_db, User, ActivityProgress, AuditLog, SessionLocal
from auth import (
    hash_password, authenticate_user, create_access_token,
    get_current_user, require_roles,
)

_HERE = Path(__file__).resolve().parent

# Flexible paths: works with data/frontend folders OR files at repo root (GitHub upload)
if (_HERE / "data" / "activities.json").exists():
    DATA_DIR = _HERE / "data"
    ACTIVITIES_FILE = DATA_DIR / "activities.json"
elif (_HERE / "activities.json").exists():
    DATA_DIR = _HERE
    ACTIVITIES_FILE = _HERE / "activities.json"
else:
    DATA_DIR = _HERE / "data"
    ACTIVITIES_FILE = DATA_DIR / "activities.json"

if (_HERE / "frontend" / "index.html").exists():
    FRONTEND_DIR = _HERE / "frontend"
elif (_HERE / "index.html").exists():
    FRONTEND_DIR = _HERE
else:
    FRONTEND_DIR = _HERE / "frontend"

app = FastAPI(title="Parada Elétrica API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- WebSocket manager (tempo real) ----------
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

# ---------- Schemas ----------
class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict

class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: str

    class Config:
        from_attributes = True

class ProgressUpdate(BaseModel):
    activity_id: int
    done: bool

class BulkProgress(BaseModel):
    activity_ids: List[int]
    done: bool

class UserCreate(BaseModel):
    username: str
    full_name: str
    password: str
    role: str = "operador"

# ---------- Startup ----------
def seed_users(db: Session):
    defaults = [
        ("admin", "Administrador", "admin123", "admin"),
        ("supervisor", "Supervisor Parada", "super123", "supervisor"),
        ("lucas", "LUCAS", "eletro123", "operador"),
        ("marcio", "MARCIO", "eletro123", "operador"),
        ("adriel", "ADRIEL", "eletro123", "operador"),
        ("carlos", "CARLOS", "eletro123", "operador"),
        ("dionatan", "DIONATAN", "eletro123", "operador"),
        ("edson", "EDSON", "eletro123", "operador"),
        ("ibson", "IBSON", "eletro123", "operador"),
        ("jadson", "JADSON", "eletro123", "operador"),
        ("leandro", "LEANDRO", "eletro123", "operador"),
        ("valter", "VALTER", "eletro123", "operador"),
        ("vandeley", "VANDELEY", "eletro123", "operador"),
    ]
    for username, full_name, password, role in defaults:
        if not db.query(User).filter(User.username == username).first():
            db.add(User(
                username=username,
                full_name=full_name,
                hashed_password=hash_password(password),
                role=role,
            ))
    db.commit()

@app.on_event("startup")
def on_startup():
    import traceback
    try:
        print("STARTUP: ACTIVITIES_FILE =", ACTIVITIES_FILE, "exists=", Path(ACTIVITIES_FILE).exists())
        print("STARTUP: FRONTEND_DIR =", FRONTEND_DIR, "exists=", FRONTEND_DIR.exists())
        if DATA_DIR:
            Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
        init_db()
        print("STARTUP: database ok")
        db = SessionLocal()
        try:
            seed_users(db)
            print("STARTUP: users seeded")
        finally:
            db.close()
        # verify activities load
        acts = load_activities()
        print("STARTUP: activities loaded =", len(acts))
    except Exception as e:
        print("STARTUP ERROR:", e)
        traceback.print_exc()
        # do not re-raise: keep API up for /health diagnosis

def load_activities() -> list:
    with open(ACTIVITIES_FILE, encoding="utf-8") as f:
        return json.load(f)

# ---------- Auth ----------
@app.post("/api/login", response_model=TokenOut)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = authenticate_user(db, form.username, form.password)
    if not user:
        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos")
    token = create_access_token({"sub": user.username, "role": user.role})
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user.id,
            "username": user.username,
            "full_name": user.full_name,
            "role": user.role,
        },
    }

@app.get("/api/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user

# ---------- Activities & Progress ----------
@app.get("/api/activities")
def get_activities(user: User = Depends(get_current_user)):
    return load_activities()

@app.get("/api/progress")
def get_progress(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(ActivityProgress).filter(ActivityProgress.done == True).all()
    return {
        "done_ids": [r.activity_id for r in rows],
        "details": [
            {
                "activity_id": r.activity_id,
                "done": r.done,
                "updated_by": r.updated_by,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }

@app.post("/api/progress")
async def set_progress(
    body: ProgressUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = db.query(ActivityProgress).filter(ActivityProgress.activity_id == body.activity_id).first()
    if not row:
        row = ActivityProgress(activity_id=body.activity_id)
        db.add(row)
    row.done = body.done
    row.updated_by = user.id
    row.updated_at = datetime.utcnow()

    action = "done" if body.done else "undone"
    db.add(AuditLog(
        activity_id=body.activity_id,
        action=action,
        user_id=user.id,
        username=user.username,
        detail=f"{user.full_name} marcou atividade {body.activity_id} como {'concluída' if body.done else 'pendente'}",
    ))
    db.commit()

    await manager.broadcast({
        "type": "progress",
        "activity_id": body.activity_id,
        "done": body.done,
        "by": user.full_name,
        "at": datetime.utcnow().isoformat(),
    })
    return {"ok": True, "activity_id": body.activity_id, "done": body.done}

@app.post("/api/progress/bulk")
async def bulk_progress(
    body: BulkProgress,
    user: User = Depends(require_roles("admin", "supervisor")),
    db: Session = Depends(get_db),
):
    for aid in body.activity_ids:
        row = db.query(ActivityProgress).filter(ActivityProgress.activity_id == aid).first()
        if not row:
            row = ActivityProgress(activity_id=aid)
            db.add(row)
        row.done = body.done
        row.updated_by = user.id
        row.updated_at = datetime.utcnow()
    db.add(AuditLog(
        activity_id=0,
        action="bulk_done" if body.done else "bulk_undone",
        user_id=user.id,
        username=user.username,
        detail=f"Bulk {len(body.activity_ids)} atividades por {user.full_name}",
    ))
    db.commit()
    await manager.broadcast({"type": "reload", "by": user.full_name})
    return {"ok": True, "count": len(body.activity_ids)}

@app.post("/api/progress/reset")
async def reset_progress(
    user: User = Depends(require_roles("admin", "supervisor")),
    db: Session = Depends(get_db),
):
    db.query(ActivityProgress).delete()
    db.add(AuditLog(
        activity_id=0,
        action="reset",
        user_id=user.id,
        username=user.username,
        detail=f"RESET completo por {user.full_name}",
    ))
    db.commit()
    await manager.broadcast({"type": "reset", "by": user.full_name})
    return {"ok": True}

@app.get("/api/audit")
def get_audit(
    limit: int = 100,
    user: User = Depends(require_roles("admin", "supervisor")),
    db: Session = Depends(get_db),
):
    rows = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "activity_id": r.activity_id,
            "action": r.action,
            "username": r.username,
            "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]

@app.get("/api/stats")
def get_stats(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    activities = load_activities()
    total_n = len(activities)
    total_h = sum(a["dur"] for a in activities)
    done_ids = set(
        r.activity_id for r in db.query(ActivityProgress).filter(ActivityProgress.done == True).all()
    )
    done_h = sum(a["dur"] for a in activities if a["id"] in done_ids)
    done_n = len(done_ids)
    return {
        "total_n": total_n,
        "total_h": total_h,
        "done_n": done_n,
        "done_h": done_h,
        "pct_n": round(done_n / total_n * 100, 1) if total_n else 0,
        "pct_h": round(done_h / total_h * 100, 1) if total_h else 0,
    }

# ---------- Users admin ----------
@app.get("/api/users", response_model=List[UserOut])
def list_users(
    user: User = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    return db.query(User).order_by(User.username).all()

@app.post("/api/users", response_model=UserOut)
def create_user(
    body: UserCreate,
    user: User = Depends(require_roles("admin")),
    db: Session = Depends(get_db),
):
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(400, "Usuário já existe")
    u = User(
        username=body.username,
        full_name=body.full_name,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u

# ---------- WebSocket ----------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()  # keep alive / ping
            if data == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(ws)

# ---------- Frontend static ----------
@app.get("/")
def index():
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "API Parada Elétrica online. Frontend em /frontend/index.html"}

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}