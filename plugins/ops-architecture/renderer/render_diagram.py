"""Draw a platform architecture diagram from a JSON spec with the `diagrams` library.

Usage:
  render_diagram.py render <out-dir> <png|svg>   spec JSON on stdin, writes <out-dir>/diagram.<fmt>
  render_diagram.py icons <provider>             prints {category: [icon classes]} as JSON

The spec is data, never code: icons are resolved by name inside the `diagrams` package only.
"""

import importlib
import json
import pkgutil
import re
import sys
from pathlib import Path

from diagrams import Cluster, Diagram, Edge, Node

PROVIDERS = {
    "alibabacloud", "aws", "azure", "c4", "digitalocean", "elastic", "firebase", "gcp", "generic",
    "gis", "ibm", "k8s", "oci", "onprem", "openstack", "outscale", "programming", "saas",
}
SEGMENT = re.compile(r"^[a-z0-9_]+$")
CLASS_NAME = re.compile(r"^[A-Z][A-Za-z0-9]*$")


class SpecError(Exception):
    pass


def icon_class(icon: str) -> type:
    parts = icon.split(".")
    if len(parts) != 3:
        raise SpecError(f"icon {icon!r} must be provider.category.Class")
    provider, category, name = parts
    if provider not in PROVIDERS or not SEGMENT.match(category) or not CLASS_NAME.match(name):
        raise SpecError(f"icon {icon!r} is not a diagrams icon name")
    try:
        module = importlib.import_module(f"diagrams.{provider}.{category}")
    except ModuleNotFoundError as err:
        raise SpecError(f"unknown icon category {provider}.{category}") from err
    cls = getattr(module, name, None)
    if not (isinstance(cls, type) and issubclass(cls, Node)):
        raise SpecError(f"unknown icon {icon}; list the provider's icons with architecture_icons")
    return cls


def clustered_ids(clusters: list) -> set:
    ids = set()
    for cluster in clusters:
        ids.update(cluster.get("nodes", []))
        ids.update(clustered_ids(cluster.get("clusters", [])))
    return ids


def render(out_dir: str, fmt: str) -> None:
    spec = json.load(sys.stdin)
    specs = {n["id"]: n for n in spec["nodes"]}
    classes = {node_id: icon_class(n["icon"]) for node_id, n in specs.items()}
    nodes: dict = {}

    def draw(ids: list) -> None:
        for node_id in ids:
            nodes[node_id] = classes[node_id](specs[node_id].get("label", ""))

    def draw_cluster(cluster: dict) -> None:
        direction = cluster.get("direction", spec.get("direction", "LR"))
        with Cluster(cluster["label"], direction=direction):
            draw(cluster.get("nodes", []))
            for child in cluster.get("clusters", []):
                draw_cluster(child)

    clusters = spec.get("clusters", [])
    inside = clustered_ids(clusters)
    graph_attr = {"fontsize": "22", "pad": "0.4", "labelloc": "t"}
    if fmt == "png":
        graph_attr["dpi"] = "150"
    with Diagram(
        spec["title"],
        filename=str(Path(out_dir) / "diagram"),
        outformat=fmt,
        show=False,
        direction=spec.get("direction", "LR"),
        graph_attr=graph_attr,
    ):
        draw([node_id for node_id in specs if node_id not in inside])
        for cluster in clusters:
            draw_cluster(cluster)
        for e in spec.get("edges", []):
            way = e.get("direction", "forward")
            edge = Edge(
                forward=way in ("forward", "both"),
                reverse=way in ("back", "both"),
                label=e.get("label", ""),
                color=e.get("color", ""),
                style=e.get("style", ""),
            )
            nodes[e["from"]].connect(nodes[e["to"]], edge)


def icons(provider: str) -> None:
    if provider not in PROVIDERS:
        raise SpecError(f"unknown provider {provider!r}")
    package = importlib.import_module(f"diagrams.{provider}")
    catalog = {}
    for info in pkgutil.iter_modules(package.__path__):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{package.__name__}.{info.name}")
        catalog[info.name] = sorted(
            name
            for name, value in vars(module).items()
            if CLASS_NAME.match(name)
            and isinstance(value, type)
            and issubclass(value, Node)
            and value.__module__ == module.__name__
        )
    print(json.dumps(catalog))


def main() -> int:
    try:
        if sys.argv[1:2] == ["render"] and len(sys.argv) == 4:
            render(sys.argv[2], sys.argv[3])
        elif sys.argv[1:2] == ["icons"] and len(sys.argv) == 3:
            icons(sys.argv[2])
        else:
            raise SpecError(__doc__ or "bad arguments")
    except SpecError as err:
        print(json.dumps({"error": str(err)}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
