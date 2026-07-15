"""Service configuration via environment variables."""
from pydantic_settings import BaseSettings
from typing import Literal


class Settings(BaseSettings):
    # Ollama endpoint (local or remote)
    ollama_base_url: str = "http://ollama:11434"

    # Preferred VLM model — first available wins at startup
    # Priority: qwen2.5vl > minicpm-v > gemma3 > llava
    vlm_model_priority: list[str] = [
        "qwen2.5vl:7b",
        "qwen2.5vl:3b",
        "minicpm-v:8b",
        "minicpm-v:latest",
        "gemma3:12b",
        "gemma3:4b",
        "llava:13b",
        "llava:7b",
    ]
    active_vlm_model: str = "qwen2.5vl:7b"  # overridden at startup

    # YOLO model (auto-downloaded by ultralytics)
    yolo_model: str = "yolo11n.pt"          # nano — fast; swap to yolo11s/m for accuracy
    yolo_conf_threshold: float = 0.35
    yolo_iou_threshold: float = 0.45
    yolo_max_detections: int = 300

    # Rust bbox post-processor sidecar
    rust_bbox_url: str = "http://rust-bbox:8082"

    # Go orchestrator (calls us)
    service_host: str = "0.0.0.0"
    service_port: int = 8081

    # Max image size to send to VLM (pixels)
    max_image_dimension: int = 1024

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
