import logging
from pathlib import Path
from typing import Any, Dict, Optional

from jinja2 import Environment, FileSystemLoader, TemplateNotFound, select_autoescape

logger = logging.getLogger(__name__)


class TemplateService:
    """Renders HTML templates for scheduling emails."""

    def __init__(self, templates_dir: Optional[Path] = None):
        if templates_dir is None:
            templates_dir = Path(__file__).resolve().parents[1] / "templates"

        self.templates_dir = templates_dir
        self.environment = Environment(
            loader=FileSystemLoader(str(self.templates_dir)),
            autoescape=select_autoescape(["html", "xml"])
        )

    def render(self, template_name: str, context: Dict[str, Any]) -> str:
        """Render a template with the provided context."""
        try:
            template = self.environment.get_template(template_name)
            return template.render(**context)
        except TemplateNotFound as exc:
            logger.error("Template not found: %s", template_name)
            raise ValueError(f"Template not found: {template_name}") from exc


def create_template_service() -> TemplateService:
    """Factory for template service."""
    return TemplateService()
