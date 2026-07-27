from sqlalchemy import create_engine, Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey
from sqlalchemy.orm import sessionmaker, declarative_base, relationship
from datetime import datetime
import os

DB_PATH = os.environ.get("DATABASE_URL", "sqlite:////tmp/parada_eletrica.db")
# Allow postgres via env: postgresql://user:pass@host/db
engine = create_engine(
    DB_PATH if DB_PATH.startswith("postgresql") else DB_PATH,
    connect_args={"check_same_thread": False} if DB_PATH.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    full_name = Column(String(120), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(30), default="operador")  # admin | supervisor | operador
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class ActivityProgress(Base):
    __tablename__ = "activity_progress"
    id = Column(Integer, primary_key=True, index=True)
    activity_id = Column(Integer, unique=True, index=True, nullable=False)
    done = Column(Boolean, default=False)
    updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id = Column(Integer, primary_key=True, index=True)
    activity_id = Column(Integer, index=True)
    action = Column(String(30))  # done | undone | reset
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    username = Column(String(50))
    created_at = Column(DateTime, default=datetime.utcnow)
    detail = Column(Text, nullable=True)


def init_db():
    Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
