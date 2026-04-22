import argparse
import base64
import csv
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from docx import Document


DEFAULT_SYSTEM_PROMPT = (
    """You are a highly experienced Senior Planner in Project Controls.

The user will provide a text file containing a Scope of Works document. Your role is to convert that document into a Work Breakdown Structure (WBS).

Rules:
- Base the WBS only on the content of the document.
- Do not infer, assume, or add scope not explicitly stated or clearly supported.
- Create up to 4 WBS levels where sufficient detail exists (1.1.2.1).
- Use fewer levels where detail is limited. Do not make up information
- Organise the WBS logically in a planner-friendly structure.
- Use concise, professional activity and deliverable names.

Output:
- Return only a Mermaid diagram in a code block.
- Use Mermaid syntax that clearly shows hierarchy.
- No prose before or after the diagram.
- Root node = project title if available, otherwise “Project WBS”.
- Can you make a output.csv file that has the following headings "WBS Level"	"WBS Code"	"WBS Name"
"""
)
DEFAULT_INPUT_FILE = "input.txt"
DEFAULT_OUTPUT_FILE = "output.txt"
DEFAULT_DIAGRAM_FILE = "output.png"
DEFAULT_HTML_FILE = "output.html"
DEFAULT_CSV_FILE = "output.csv"


def run_workflow(user_input: str, system_prompt: str, model: str) -> str:
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    response = client.responses.create(
        model=model,
        instructions=system_prompt,
        input=user_input,
    )

    return response.output_text.strip()


def read_input_file(input_file: str) -> str:
    input_path = Path(input_file)

    if input_path.suffix.lower() == ".docx":
        document = Document(input_path)
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        return text.strip()

    if input_path.suffix.lower() in {"", ".txt", ".md"}:
        return input_path.read_text(encoding="utf-8").strip()

    raise ValueError(
        f"Unsupported input file type '{input_path.suffix}'. "
        "Use .txt, .md, or .docx."
    )


def extract_mermaid_code(text: str) -> str | None:
    code_block_match = re.search(
        r"```mermaid\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE
    )
    if code_block_match:
        return code_block_match.group(1).strip()

    # Fallback for responses that are raw Mermaid without fences.
    raw_text = text.strip()
    if raw_text.startswith(("graph ", "flowchart ", "mindmap", "timeline", "sequenceDiagram")):
        return raw_text

    return None


def render_mermaid_diagram_with_kroki(mermaid_code: str, diagram_file: str) -> None:
    request = urllib.request.Request(
        url="https://kroki.io/mermaid/png",
        data=mermaid_code.encode("utf-8"),
        headers={"Content-Type": "text/plain"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        image_bytes = response.read()

    Path(diagram_file).write_bytes(image_bytes)


def render_mermaid_diagram_with_mermaid_ink(mermaid_code: str, diagram_file: str) -> None:
    encoded = base64.urlsafe_b64encode(mermaid_code.encode("utf-8")).decode("ascii")
    url = f"https://mermaid.ink/img/{encoded}"
    with urllib.request.urlopen(url, timeout=30) as response:
        image_bytes = response.read()
    Path(diagram_file).write_bytes(image_bytes)


def save_mermaid_html(mermaid_code: str, html_file: str) -> None:
    html_content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mermaid Diagram</title>
</head>
<body>
  <pre class="mermaid">
{mermaid_code}
  </pre>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
    mermaid.initialize({{ startOnLoad: true }});
  </script>
</body>
</html>
"""
    Path(html_file).write_text(html_content, encoding="utf-8")


def save_plain_html(raw_text: str, html_file: str) -> None:
    escaped_text = (
        raw_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    html_content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Workflow Output</title>
</head>
<body>
  <h1>No Mermaid Diagram Detected</h1>
  <pre>{escaped_text}</pre>
</body>
</html>
"""
    Path(html_file).write_text(html_content, encoding="utf-8")


def parse_mermaid_node_fragment(fragment: str) -> tuple[str | None, str | None]:
    cleaned = fragment.strip().rstrip(";")
    match = re.match(r"^([A-Za-z][A-Za-z0-9_]*)", cleaned)
    if not match:
        return None, None

    node_id = match.group(1)
    label: str | None = None

    bracket_start = cleaned.find("[")
    bracket_end = cleaned.rfind("]")
    if bracket_start != -1 and bracket_end > bracket_start:
        label = cleaned[bracket_start + 1 : bracket_end].strip().strip("\"'")
    else:
        paren_start = cleaned.find("(")
        paren_end = cleaned.rfind(")")
        if paren_start != -1 and paren_end > paren_start:
            label = cleaned[paren_start + 1 : paren_end].strip().strip("\"'")

    if label:
        return node_id, label
    return node_id, None


def build_wbs_rows_from_mermaid(mermaid_code: str) -> list[tuple[int, str, str]]:
    node_labels: dict[str, str] = {}
    children: dict[str, list[str]] = {}
    destinations: set[str] = set()
    node_order: list[str] = []

    def remember_node(node_id: str) -> None:
        if node_id not in children:
            children[node_id] = []
        if node_id not in node_order:
            node_order.append(node_id)

    for raw_line in mermaid_code.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("%%"):
            continue
        if line.startswith(
            ("graph ", "flowchart ", "mindmap", "timeline", "sequenceDiagram")
        ):
            continue

        if "-->" in line:
            left, right = line.split("-->", 1)
            # Remove optional edge label format: A -->|label| B
            right_clean = right.strip()
            if right_clean.startswith("|") and "|" in right_clean[1:]:
                second_pipe_index = right_clean.find("|", 1)
                right = right_clean[second_pipe_index + 1 :]

            src_id, src_label = parse_mermaid_node_fragment(left)
            dst_id, dst_label = parse_mermaid_node_fragment(right)
            if not src_id or not dst_id:
                continue

            remember_node(src_id)
            remember_node(dst_id)
            destinations.add(dst_id)
            if dst_id not in children[src_id]:
                children[src_id].append(dst_id)
            if src_label:
                node_labels[src_id] = src_label
            if dst_label:
                node_labels[dst_id] = dst_label
        else:
            node_id, node_label = parse_mermaid_node_fragment(line)
            if not node_id:
                continue
            remember_node(node_id)
            if node_label:
                node_labels[node_id] = node_label

    if not node_order:
        return []

    roots = [node_id for node_id in node_order if node_id not in destinations]
    if not roots:
        roots = node_order[:1]

    rows: list[tuple[int, str, str]] = []
    visited: set[str] = set()

    def dfs(node_id: str, level: int, code: str) -> None:
        if node_id in visited:
            return
        visited.add(node_id)
        rows.append((level, code, node_labels.get(node_id, node_id)))
        for index, child_id in enumerate(children.get(node_id, []), start=1):
            dfs(child_id, level + 1, f"{code}.{index}")

    top_level_index = 1
    for root_id in roots:
        if root_id in visited:
            continue
        dfs(root_id, 1, str(top_level_index))
        top_level_index += 1

    for node_id in node_order:
        if node_id in visited:
            continue
        dfs(node_id, 1, str(top_level_index))
        top_level_index += 1

    return rows


def save_wbs_csv(rows: list[tuple[int, str, str]], csv_file: str) -> None:
    with open(csv_file, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(["WBS Level", "WBS Code", "WBS Name"])
        for level, code, name in rows:
            writer.writerow([level, code, name])


def render_mermaid_diagram(mermaid_code: str, diagram_file: str, mermaid_source_file: str) -> str | None:
    mmdc_path = shutil.which("mmdc")
    if mmdc_path:
        try:
            subprocess.run(
                [mmdc_path, "-i", mermaid_source_file, "-o", diagram_file],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            return "local-mermaid-cli"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass

    npx_path = shutil.which("npx")
    if npx_path:
        try:
            subprocess.run(
                [
                    npx_path,
                    "-y",
                    "@mermaid-js/mermaid-cli",
                    "-i",
                    mermaid_source_file,
                    "-o",
                    diagram_file,
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=90,
            )
            return "npx-mermaid-cli"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass

    try:
        render_mermaid_diagram_with_mermaid_ink(mermaid_code, diagram_file)
        return "mermaid-ink"
    except (urllib.error.HTTPError, urllib.error.URLError):
        pass

    try:
        render_mermaid_diagram_with_kroki(mermaid_code, diagram_file)
        return "kroki"
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a terminal-only AI workflow with OpenAI."
    )
    parser.add_argument(
        "--input",
        "-i",
        help="Input text to send to the AI. Overrides --input-file when provided.",
    )
    parser.add_argument(
        "--input-file",
        "-f",
        help=f"Path to a text file to use as input (default: {DEFAULT_INPUT_FILE}).",
    )
    parser.add_argument(
        "--system-prompt",
        "-p",
        default=DEFAULT_SYSTEM_PROMPT,
        help="System prompt/instructions for the AI.",
    )
    parser.add_argument(
        "--model",
        "-m",
        default="gpt-5-mini",
        help="OpenAI model to use.",
    )
    parser.add_argument(
        "--output-file",
        "-o",
        default=DEFAULT_OUTPUT_FILE,
        help=f"Path to save AI output (default: {DEFAULT_OUTPUT_FILE}).",
    )
    parser.add_argument(
        "--diagram-file",
        default=DEFAULT_DIAGRAM_FILE,
        help=f"Path to save rendered Mermaid diagram PNG (default: {DEFAULT_DIAGRAM_FILE}).",
    )
    parser.add_argument(
        "--html-file",
        default=DEFAULT_HTML_FILE,
        help=f"Path to save Mermaid HTML render file (default: {DEFAULT_HTML_FILE}).",
    )
    parser.add_argument(
        "--csv-file",
        default=DEFAULT_CSV_FILE,
        help=f"Path to save WBS CSV table (default: {DEFAULT_CSV_FILE}).",
    )
    return parser.parse_args()


def main() -> int:
    load_dotenv()
    args = parse_args()

    if not os.getenv("OPENAI_API_KEY"):
        print(
            "Error: OPENAI_API_KEY is not set. Add it to your environment or .env file.",
            file=sys.stderr,
        )
        return 1

    user_input = args.input
    input_file = args.input_file or DEFAULT_INPUT_FILE

    if not user_input:
        try:
            user_input = read_input_file(input_file)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        except OSError as exc:
            print(f"Error reading input file '{input_file}': {exc}", file=sys.stderr)
            return 1

    if not user_input:
        print("Error: input text cannot be empty.", file=sys.stderr)
        return 1

    try:
        result = run_workflow(
            user_input=user_input,
            system_prompt=args.system_prompt,
            model=args.model,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"OpenAI request failed: {exc}", file=sys.stderr)
        return 1

    print("\n=== AI Response ===")
    print(result)
    try:
        Path(args.output_file).write_text(result + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"Error writing output file '{args.output_file}': {exc}", file=sys.stderr)
        return 1

    print(f"\nSaved response to {args.output_file}")

    mermaid_code = extract_mermaid_code(result)
    if not mermaid_code:
        try:
            save_plain_html(result, args.html_file)
            save_wbs_csv([], args.csv_file)
        except OSError as exc:
            print(f"Error saving HTML/CSV output: {exc}", file=sys.stderr)
            return 1
        print("No Mermaid diagram detected; saved plain HTML and CSV headers only.")
        print(f"Saved HTML output to {args.html_file}")
        print(f"Saved CSV output to {args.csv_file}")
        return 0

    mermaid_source_file = str(Path(args.diagram_file).with_suffix(".mmd"))
    wbs_rows = build_wbs_rows_from_mermaid(mermaid_code)
    try:
        Path(mermaid_source_file).write_text(mermaid_code + "\n", encoding="utf-8")
        save_mermaid_html(mermaid_code, args.html_file)
        save_wbs_csv(wbs_rows, args.csv_file)
        render_method = render_mermaid_diagram(
            mermaid_code=mermaid_code,
            diagram_file=args.diagram_file,
            mermaid_source_file=mermaid_source_file,
        )
    except OSError as exc:
        print(f"Error saving Mermaid files: {exc}", file=sys.stderr)
        return 1

    print(f"Saved Mermaid source to {mermaid_source_file}")
    print(f"Saved Mermaid HTML render to {args.html_file}")
    print(f"Saved WBS CSV output to {args.csv_file}")
    if render_method:
        print(f"Saved Mermaid PNG render to {args.diagram_file} (via {render_method})")
    else:
        print("Could not produce Mermaid PNG in this environment; use the HTML render file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
