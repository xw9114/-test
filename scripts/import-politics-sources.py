#!/usr/bin/env python3
"""Import local politics course materials into data/question-bank.json.

Supported inputs: .pdf, .docx, .md, .txt, .html/.htm.
The parser intentionally keeps only records that look like objective questions
and have an explicit answer marker.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
from pathlib import Path


TYPE_MAP = {
    "单选": "single",
    "单项选择": "single",
    "多选": "multiple",
    "多项选择": "multiple",
    "判断": "judgement",
    "填空": "fill",
    "简答": "short",
}


def clean(text: str) -> str:
    text = html.unescape(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t\r\f\v\u3000]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def norm(text: str) -> str:
    return re.sub(r"[\s，。；;：:、,.!?！？()（）【】\[\]\"'“”]+", "", clean(text)).lower()


def read_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".txt", ".html", ".htm"}:
        return path.read_text("utf-8", errors="ignore")
    if suffix == ".docx":
        import docx  # type: ignore

        doc = docx.Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs)
    if suffix == ".pdf":
        import pdfplumber  # type: ignore

        chunks: list[str] = []
        with pdfplumber.open(str(path)) as pdf:
            for page in pdf.pages:
                chunks.append(page.extract_text() or "")
        return "\n".join(chunks)
    return ""


def detect_type(block: str) -> str:
    for key, value in TYPE_MAP.items():
        if key in block[:80]:
            return value
    if re.search(r"正确|错误|对|错|√|×", block) and len(re.findall(r"^[A-D][.、．]\s*", block, re.M)) <= 2:
        return "judgement"
    return "single"


def split_blocks(text: str) -> list[str]:
    text = clean(text)
    pattern = re.compile(r"(?m)(?=^\s*(?:\d{1,4}|[一二三四五六七八九十]+)\s*[.、．)]\s*)")
    blocks = [b.strip() for b in pattern.split(text) if b.strip()]
    if len(blocks) <= 2:
        blocks = re.split(r"\n\s*\n", text)
    return [b for b in blocks if len(b) >= 20]


def parse_options(block: str) -> list[dict[str, str]]:
    options: list[dict[str, str]] = []
    option_re = re.compile(
        r"(?ms)(?:^|\n)\s*([A-H])\s*[.、．:：)]\s*(.*?)(?=(?:\n\s*[A-H]\s*[.、．:：)]\s*)|\n\s*(?:答案|参考答案|正确答案)\s*[:：]|$)"
    )
    for key, value in option_re.findall(block):
        value = clean(value)
        if value:
            options.append({"key": key.upper(), "text": value})
    return options


def parse_answer(block: str) -> list[str]:
    answer_re = re.search(r"(?:答案|参考答案|正确答案)\s*[:：]\s*([^\n。；;]+)", block)
    if not answer_re:
        return []
    raw = clean(answer_re.group(1))
    return [p for p in re.split(r"\s*(?:#|,|，|、|;|；|\||/)\s*", raw) if p]


def parse_question(block: str, options: list[dict[str, str]]) -> str:
    head = re.split(r"\n\s*A\s*[.、．:：)]\s*", block, maxsplit=1)[0]
    head = re.sub(r"^\s*(?:\d{1,4}|[一二三四五六七八九十]+)\s*[.、．)]\s*", "", head)
    head = re.sub(r"(?:答案|参考答案|正确答案)\s*[:：].*$", "", head, flags=re.S)
    for option in options:
        head = head.replace(option["text"], " ")
    return clean(head)


def record_from_block(block: str, source: str) -> dict | None:
    options = parse_options(block)
    answers = parse_answer(block)
    if not answers:
        return None
    question = parse_question(block, options)
    if len(question) < 6:
        return None
    qtype = detect_type(block)
    answer_keys = [a.upper() for a in answers if re.fullmatch(r"[A-H]", a.strip(), re.I)]
    key_to_text = {o["key"]: o["text"] for o in options}
    answer_texts = [key_to_text[k] for k in answer_keys if k in key_to_text]
    answer_texts.extend(a for a in answers if not re.fullmatch(r"[A-H]", a.strip(), re.I))
    if qtype in {"single", "multiple", "judgement"} and options and not answer_texts and not answer_keys:
        return None
    digest = hashlib.sha1((norm(question) + "|" + "|".join(norm(o["text"]) for o in options)).encode("utf-8")).hexdigest()[:16]
    return {
        "id": digest,
        "subject": "思政",
        "source": source,
        "type": qtype,
        "question": question,
        "options": options,
        "answerKeys": answer_keys,
        "answerTexts": answer_texts,
        "confidence": 0.9,
    }


def iter_files(inputs: list[Path]):
    suffixes = {".pdf", ".docx", ".md", ".txt", ".html", ".htm"}
    for item in inputs:
        if item.is_dir():
            yield from (p for p in item.rglob("*") if p.suffix.lower() in suffixes)
        elif item.suffix.lower() in suffixes:
            yield item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("inputs", nargs="+", type=Path, help="Files or directories to import")
    parser.add_argument("--out", type=Path, default=Path("data/question-bank.json"))
    args = parser.parse_args()

    records: dict[str, dict] = {}
    for file in iter_files(args.inputs):
        try:
            text = read_text(file)
            count_before = len(records)
            for block in split_blocks(text):
                record = record_from_block(block, str(file))
                if record:
                    records.setdefault(record["id"], record)
            print(f"{file}: +{len(records) - count_before}")
        except Exception as exc:  # noqa: BLE001
            print(f"{file}: skipped ({exc})")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2), "utf-8")
    print(f"Wrote {len(records)} records to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
