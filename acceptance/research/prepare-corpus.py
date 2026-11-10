import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory


class PaperText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"style", "script"}:
            self.hidden += 1
        if tag in {"p", "tr", "li", "section", "h1", "h2", "h3", "pre"}:
            self.parts.append("\n")
        if tag in {"td", "th"}:
            self.parts.append(" | ")

    def handle_endtag(self, tag):
        if tag in {"style", "script"}:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract(raw, format):
    if format == "pdf":
        return subprocess.check_output(["swift", "-e", """
import Foundation
import PDFKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let pdf = PDFDocument(url: url), let text = pdf.string else { exit(1) }
print(text)
""", str(raw)], text=True, timeout=90)
    text = raw.read_text()
    if format == "html":
        paper = PaperText()
        paper.feed(text)
        text = re.sub(r"\n{3,}", "\n\n", "".join(paper.parts))
    return text


def build_snapshot(case, definition, corpus, raw_dir):
    corpus.mkdir(parents=True)
    evidence = {}
    index = [f"Source collection for {case}. Evidence cutoff {definition['cutoff']}.", ""]
    for source in definition["sources"]:
        source_id = source["id"]
        raw = raw_dir / f"{source_id}.{source['format']}"
        temporary = raw.with_suffix(".part")
        subprocess.run(["curl", "-fsSL", "--max-time", "60", "--retry", "1",
                        source["url"], "-o", str(temporary)], check=True)
        temporary.replace(raw)
        text = extract(raw, source["format"])
        if len(text.strip()) < 1000:
            raise ValueError(f"Missing source text for {source_id}")
        local = corpus / f"{source_id}.txt"
        local.write_text(f"Primary reference {source['reference']}\n"
                         f"Versioned material {source['url']}\n\n{text}\n")
        evidence[source_id] = {"original": digest(raw), "text": digest(local)}
        index.append(f"- {local.name} | {source['reference']} | {source['license']}")
    (corpus / "sources.md").write_text("\n".join(index) + "\n")
    for command in [
        ["init", "-q", "-b", "main"],
        ["add", "."],
        ["-c", "user.name=DWF Evaluation", "-c", "user.email=evaluation@example.invalid",
         "commit", "-qm", "Frozen public research corpus"],
    ]:
        subprocess.run(["git", *command], cwd=corpus, check=True)
    (raw_dir / "fingerprints.json").write_text(json.dumps(evidence, indent=2) + "\n")


def prepare(case, definition, root):
    corpus = root / "corpus" / case
    if corpus.exists():
        raise SystemExit(f"Corpus already exists at {corpus}. Use a fresh root to fetch again.")
    raw_dir = root / "downloads" / case
    raw_dir.mkdir(parents=True, exist_ok=True)
    corpus.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=corpus.parent) as staging:
        snapshot = Path(staging) / case
        build_snapshot(case, definition, snapshot, raw_dir)
        snapshot.rename(corpus)
    print(corpus, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("cases", nargs="+")
    args = parser.parse_args()
    definitions = json.loads(Path(__file__).with_name("cases.json").read_text())
    for case in args.cases:
        prepare(case, definitions[case], args.root.resolve())
