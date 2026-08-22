from __future__ import annotations

from pathlib import PurePosixPath

GRID_CELL_SIZE = 96
COLUMNS_PER_ROW = 6


def build_village_layout(repo_map: list[dict]) -> list[dict]:
    """Grid layout for the Village: sort by directory path, place buildings
    left to right, and start a new row whenever the directory changes (a
    subfolder's files are offset onto their own row(s)). A plain for-loop,
    deliberately not force-directed / physics-based.
    """
    sorted_entries = sorted(
        repo_map,
        key=lambda entry: PurePosixPath(str(entry["filename"]).replace("\\", "/")).parts,
    )

    positioned: list[dict] = []
    current_directory: tuple[str, ...] | None = None
    row = 0
    col = 0
    for entry in sorted_entries:
        parts = PurePosixPath(str(entry["filename"]).replace("\\", "/")).parts
        directory = parts[:-1]
        if directory != current_directory:
            if current_directory is not None:
                row += 1
                col = 0
            current_directory = directory
        if col >= COLUMNS_PER_ROW:
            row += 1
            col = 0
        positioned.append(
            {
                **entry,
                "directory": "/".join(directory),
                "x": col * GRID_CELL_SIZE,
                "y": row * GRID_CELL_SIZE,
            }
        )
        col += 1
    return positioned


def build_import_edges(repo_map: list[dict]) -> list[dict]:
    """One villager NPC per import edge (A imports B), internal imports only."""
    stems: dict[str, str] = {}
    for entry in repo_map:
        filename = str(entry["filename"]).replace("\\", "/")
        stem = filename[:-3] if filename.endswith(".py") else filename
        stems[stem.replace("/", ".")] = filename
        stems[PurePosixPath(stem).name] = filename

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for entry in repo_map:
        source = str(entry["filename"]).replace("\\", "/")
        for imported in entry.get("imports", []):
            target = stems.get(str(imported))
            if not target or target == source:
                continue
            key = (source, target)
            if key in seen:
                continue
            seen.add(key)
            edges.append({"from": source, "to": target})
    return edges
