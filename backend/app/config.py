from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://xian:xian@localhost:5432/xian_house"
    amap_web_key: str = ""
    amap_js_key: str = ""
    amap_js_security: str = ""
    boundary_provider: str = "osm"  # osm | amap | auto
    overpass_urls: str = ""
    osm_road_fetch_delay_seconds: float = 1.0
    crawl_delay_seconds: float = 3.0
    crawl_max_pages: int = 2
    spike_results_dir: str = "/spike_results"


@lru_cache
def get_settings() -> Settings:
    return Settings()
