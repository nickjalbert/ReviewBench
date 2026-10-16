import errno
import json
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import time


EMPTY = "No significant issues found in the reviewed changes."


def require_no_judge_credentials():
    for key in (
        "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "RB_HARBOR_JUDGE_KEY",
        "CAPI_DEV_KEY", "RB_HARBOR_CAPI_KEY",
    ):
        if os.environ.get(key):
            raise RuntimeError(f"Judge credential exposed to reviewer: {key}")


def findings_from_review(text, repo):
    text = text.strip()
    if text == EMPTY:
        return []
    chunks = re.split(r"(?m)^## Issue:\s*", text)
    if len(chunks) < 2 or chunks[0].strip():
        raise ValueError("Unrecognized native code-review output; refusing empty fallback")
    findings = []
    for chunk in chunks[1:]:
        location = re.search(r"(?m)^\*\*File:\*\*\s*`?([^`\r\n]+?)(?::(\d+))(?:[-\u2013](\d+))?`?\s*$", chunk)
        if not location or not all(f"**{field}:**" in chunk for field in ("Severity", "Problem", "Evidence", "Suggested fix")):
            raise ValueError("Incomplete native issue format")
        path = Path(location[1])
        path = (path if path.is_absolute() else repo / path).resolve()
        relative = path.relative_to(repo.resolve()).as_posix()
        start, end = int(location[2]), int(location[3] or location[2])
        if not path.is_file() or start < 1 or end < start or end > len(path.read_text().splitlines()):
            raise ValueError("Native finding has an invalid HEAD location")
        findings.append({
            "producer": "copilot-native-review", "file": relative,
            "start_line": start, "end_line": end, "message": "## Issue: " + chunk.strip(),
        })
    return findings


def read_events(home):
    paths = list(home.glob("session-state/*/events.jsonl"))
    if len(paths) > 1:
        raise RuntimeError("Ambiguous root Copilot session")
    events = []
    if paths:
        lines = paths[0].read_text().splitlines()
        for index, line in enumerate(lines):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                if index != len(lines) - 1:
                    raise
    return events


def review_result(events):
    calls = set()
    for event in events:
        data = event.get("data", {})
        if event["type"] == "tool.execution_start" and data.get("toolName") == "task":
            args = data.get("arguments", {})
            if isinstance(args, str):
                args = json.loads(args)
            if args.get("agent_type") == "code-review":
                calls.add(data["toolCallId"])
        if event["type"] == "tool.execution_complete" and data.get("toolCallId") in calls:
            if data.get("success") is not True:
                raise RuntimeError("Native code-review tool failed")
            result = data.get("result")
            if isinstance(result, dict):
                result = result.get("content")
            if not isinstance(result, str):
                raise RuntimeError("Unexpected native task response shape")
            return result
    return None


def main():
    import fcntl
    import pty
    import termios

    repo = Path("/work/repo")
    logs = Path("/logs/agent")
    logs.mkdir(parents=True, exist_ok=True)
    require_no_judge_credentials()
    if Path("/tests").exists() or Path("/solution").exists():
        raise RuntimeError("Verifier or oracle assets exposed to reviewer")
    blocked = subprocess.run(["curl", "-sS", "--noproxy", "*", "--max-time", "10", "https://example.com"], capture_output=True)
    if blocked.returncode == 0:
        raise RuntimeError("Non-allowlisted reviewer egress succeeded")
    (logs / "isolation.json").write_text(json.dumps({
        "judge_credentials_absent": True, "verifier_assets_absent": True, "external_egress_blocked": True,
    }))
    home = Path("/tmp/rb-copilot-home")
    home.mkdir()
    (home / "config.json").write_text(json.dumps({
        "trusted_folders": [str(repo)], "trustedFolders": [str(repo)],
    }))
    env = {**os.environ, "COPILOT_HOME": str(home), "TERM": "xterm-256color",
           "DO_NOT_TRACK": "1", "NO_COLOR": "1"}
    command = [
        "copilot", "--no-auto-update", "--no-remote-export", "--screen-reader",
        "--allow-all", "--disable-builtin-mcps", "--no-ask-user",
        "--deny-tool=web_fetch", "--deny-tool=web_search", "-i", "/review",
    ]
    (logs / "invocation.json").write_text(json.dumps(command))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
    process = subprocess.Popen(command, cwd=repo, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    started = time.monotonic()
    complete_at = None
    transcript = bytearray()
    try:
        with (logs / "terminal.txt").open("wb") as output:
            while time.monotonic() - started < 2100:
                if select.select([master], [], [], 1)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    if chunk:
                        transcript.extend(chunk)
                        output.write(chunk)
                        output.flush()
                        if b"\x1b[6n" in chunk:
                            os.write(master, b"\x1b[1;1R")
                events = read_events(home)
                result = review_result(events)
                if result is not None:
                    # Wait for the parent response to settle, not just an intermediate tool result.
                    completed_index = max(i for i, e in enumerate(events) if e["type"] == "tool.execution_complete")
                    settled = any(e["type"] in ("session.idle", "assistant.turn_end") and not e.get("parentToolCallId")
                                  for e in events[completed_index + 1:])
                    if settled:
                        complete_at = complete_at or time.monotonic()
                    if complete_at and time.monotonic() - complete_at > 5:
                        os.write(master, b"/exit\r")
                        break
                if process.poll() is not None:
                    break
            else:
                raise TimeoutError("Native interactive /review timed out")
    finally:
        if process.poll() is None:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=15)
        os.close(master)
        events = read_events(home)
        (logs / "native-events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
    result = review_result(events)
    native = "Review: my code changes" in transcript.decode(errors="replace") or any(
        e["type"] == "user.message" and "The user has requested a code review via the /review command." in str(e.get("data"))
        for e in events
    )
    if not native or result is None:
        raise RuntimeError("No verified native /review dispatch and successful code-review result")
    (logs / "native-review.md").write_text(result)
    findings = findings_from_review(result, repo)
    pr = json.loads(Path("/work/pr/pr.json").read_text())
    candidate = {"pr": {key: pr[key] for key in ("repo", "pr_number", "base", "head")},
                 "agent": "copilot-native-review", "findings": findings}
    Path("/work/out/findings.json").write_text(json.dumps(candidate) + "\n")
    messages = [e["data"] for e in events if e["type"] == "assistant.message"]
    (logs / "native-proof.json").write_text(json.dumps({
        "native_dispatch": native, "review_tool_success": True, "finding_count": len(findings),
        "models": sorted({m["model"] for m in messages if m.get("model")}),
        "output_tokens": (sum(m.get("outputTokens") or 0 for m in messages)
                          if any(m.get("outputTokens") is not None for m in messages) else None),
        "invocation": command,
    }, indent=2))
    print(f"Native /review verified; {len(findings)} findings converted without an LLM rewrite.")


if __name__ == "__main__":
    main()
