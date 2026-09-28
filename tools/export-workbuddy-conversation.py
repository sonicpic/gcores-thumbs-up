#!/usr/bin/env python
"""Export the WorkBuddy '机核点赞脚本' conversation into a readable, sanitized Markdown.

Source: ~/.workbuddy/projects/<project-slug>/<session-id>.jsonl (WorkBuddy local transcript).
The raw JSONL contains secrets (PushPlus token, storageState, tool outputs), so it is
copied to docs/workbuddy-archive/raw/ (gitignored) and only this sanitized extract
(user questions + assistant answers) is committed.
"""
import json
import re
import datetime
from pathlib import Path

SESSION_ID = "c6680c5a-3a9e-4334-b1cb-f85d3a228881"
PROJECT_SLUG = "c-Users-zhihongpan-WorkBuddy-Worktrees-gcores-thumbs-up-main-1cbac61b"
SRC = Path.home() / ".workbuddy" / "projects" / PROJECT_SLUG / f"{SESSION_ID}.jsonl"
ARCHIVE = Path(__file__).resolve().parent.parent / "docs" / "workbuddy-archive"
RAW_DIR = ARCHIVE / "raw"

PUSHPLUS_TOKEN = json.loads(
    (Path(__file__).resolve().parent.parent / "headless-worker" / "config.local.json").read_text("utf-8")
)["notifications"]["pushplusToken"]

REDACTIONS = [
    (re.compile(re.escape(PUSHPLUS_TOKEN)), "<REDACTED:pushplus-token>"),
    (re.compile(r"ghp_[A-Za-z0-9]{20,}"), "<REDACTED:github-token>"),
    (re.compile(r'("appToken"\s*:\s*")[^"]+(")'), r"\1<REDACTED>\2"),
    (re.compile(r'("userID"\s*:\s*")[^"]+(")'), r"\1<REDACTED>\2"),
]


def sanitize(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text


def ts(obj) -> str:
    return datetime.datetime.fromtimestamp(obj["timestamp"] / 1000).strftime("%Y-%m-%d %H:%M")


def user_text(obj) -> str | None:
    parts = []
    for c in obj.get("content", []):
        if c.get("type") == "input_text":
            parts.append(c.get("text", ""))
    full = "\n".join(parts)
    # Keep only the real query: <user_query> block if present, else plain text
    m = re.search(r"<user_query>(.*?)</user_query>", full, flags=re.S)
    if m:
        return m.group(1).strip()
    full = re.sub(r"<system-reminder.*?</system-reminder>", "", full, flags=re.S)
    full = re.sub(r"<ENVIRONMENT_CONTEXT>.*?</ENVIRONMENT_CONTEXT>", "", full, flags=re.S)
    full = full.strip()
    if not full:
        return None
    # Skip injected continuations / task notifications
    if full.startswith(("<task-notification", "<cb_summary", "<conversation_history_summary",
                        "Please continue with the conversation", "Use the TaskOutput tool")):
        return None
    return full


def assistant_text(obj) -> str | None:
    parts = [c.get("text", "") for c in obj.get("content", []) if c.get("type") == "output_text"]
    full = "\n".join(p for p in parts if p).strip()
    return full or None


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw_copy = RAW_DIR / f"{SESSION_ID}.jsonl"
    raw_copy.write_bytes(SRC.read_bytes())

    entries = []
    with SRC.open(encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "message":
                continue
            if obj.get("role") == "user":
                text = user_text(obj)
                if text:
                    entries.append(("🧑 用户", ts(obj), sanitize(text)))
            elif obj.get("role") == "assistant":
                text = assistant_text(obj)
                if text:
                    entries.append(("🤖 助手", ts(obj), sanitize(text)))

    lines = [
        "# WorkBuddy 对话导出：机核点赞脚本（v0.2 → v0.3 无头化改造）",
        "",
        "- 会话 ID：`" + SESSION_ID + "`",
        "- 工作目录：`C:\\Users\\zhihongpan\\WorkBuddy\\Worktrees\\gcores-thumbs-up\\main-1cbac61b`（git worktree，已废弃）",
        "- 时间：2026-09-21 02:01 ~ 12:02",
        f"- 消息条数：{len(entries)}（用户 + 助手正文，工具调用已省略）",
        "- 脱敏：PushPlus token / GitHub token / appToken / userID 已替换为 `<REDACTED:...>`。",
        "  **未脱敏的原始 JSONL 在 `docs/workbuddy-archive/raw/`（已 gitignore，不入库）。**",
        "",
        "---",
        "",
    ]
    for role, when, text in entries:
        lines.append(f"## {role} · {when}")
        lines.append("")
        lines.append(text)
        lines.append("")

    out = ARCHIVE / "conversation-2026-09-21-gcores-headless.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out} ({len(entries)} messages)")
    print(f"raw copy at {raw_copy} ({raw_copy.stat().st_size} bytes)")

    # Safety gate: the committed extract must not contain the real token.
    body = out.read_text("utf-8")
    assert PUSHPLUS_TOKEN not in body, "LEAK: pushplus token still present in sanitized export"
    print("sanitization check passed")


if __name__ == "__main__":
    main()
