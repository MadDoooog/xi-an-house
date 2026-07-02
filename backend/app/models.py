from datetime import datetime
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    external_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    district: Mapped[str | None] = mapped_column(String(64))
    developer: Mapped[str | None] = mapped_column(String(255))
    location_text: Mapped[str | None] = mapped_column(Text)
    permit_no: Mapped[str | None] = mapped_column(String(32))
    sale_type: Mapped[str] = mapped_column(String(32), index=True)
    published_at: Mapped[str | None] = mapped_column(String(32))
    total_units: Mapped[int | None] = mapped_column(Integer)
    sold_units: Mapped[int | None] = mapped_column(Integer)
    available_units: Mapped[int | None] = mapped_column(Integer)
    sold_ratio: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str | None] = mapped_column(String(32), index=True)
    data_source: Mapped[str | None] = mapped_column(String(64))
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    community: Mapped["Community | None"] = relationship(back_populates="project", uselist=False)


class Community(Base):
    __tablename__ = "communities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), unique=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    category: Mapped[str] = mapped_column(String(32), index=True)
    filing_price: Mapped[float | None] = mapped_column(Float)
    market_price: Mapped[float | None] = mapped_column(Float)
    display_price: Mapped[float | None] = mapped_column(Float)
    boundary_source: Mapped[str | None] = mapped_column(String(32))
    geom = mapped_column(Geometry(geometry_type="POLYGON", srid=4326), nullable=True)
    center = mapped_column(Geometry(geometry_type="POINT", srid=4326), nullable=True)
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    project: Mapped[Project] = relationship(back_populates="community")


class CrawlJob(Base):
    __tablename__ = "crawl_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32))
    records_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
