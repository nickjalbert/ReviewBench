import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import urllib.request

import json5
from harbor.agents.base import BaseAgent


COPILOT_VERSION = "1.0.96"
COPILOT_URL = (
    f"https://github.com/github/copilot-cli/releases/download/v{COPILOT_VERSION}/copilot-linux-x64.tar.gz"
)
COPILOT_SHA256 = "66b60b58b14d72390f30d6d7f8480d18a0f05c111d132e4ff8f92ae637d413f8"
_download_lock = threading.Lock()


def _login_config(path):
    if not path.exists():
        return {}
    try:
        config = json5.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        raise RuntimeError("Cannot read Copilot login configuration; run copilot login again") from None
    if not isinstance(config, dict):
        raise RuntimeError("Invalid Copilot login configuration; run copilot login again")
    return config


def _reviewer_credential(token):
    if not isinstance(token, str) or not token or any(character.isspace() for character in token):
        raise RuntimeError("Invalid saved Copilot credential; run copilot login again")
    return token


def reviewer_token():
    token = os.environ.get("COPILOT_GITHUB_TOKEN")
    if token:
        return _reviewer_credential(token)
    configured_home = os.environ.get("COPILOT_HOME")
    home = Path(configured_home).expanduser() if configured_home else Path.home() / ".copilot"
    config = _login_config(home / "config.json")
    user = config.get("lastLoggedInUser", config.get("last_logged_in_user"))
    if user is None:
        users = config.get("loggedInUsers", config.get("logged_in_users", []))
        if isinstance(users, list) and users:
            user = users[0]
    if not isinstance(user, dict) or not isinstance(user.get("login"), str) or not user["login"]:
        raise RuntimeError("Copilot login unavailable on this runner; run copilot login --device-code")
    host = user.get("host")
    if host not in ("https://github.com", "github.com"):
        raise RuntimeError("The public benchmark requires a github.com Copilot login")
    account = f'{host}:{user["login"]}'
    auth_tokens = config.get("authTokens", {})
    if not isinstance(auth_tokens, dict):
        raise RuntimeError("Invalid Copilot login configuration; run copilot login again")
    for key in (f"{account}:github", account):
        if key in auth_tokens:
            saved = auth_tokens[key]
            if not isinstance(saved, dict) or "token" not in saved:
                raise RuntimeError("Invalid saved Copilot credential; run copilot login again")
            return _reviewer_credential(saved["token"])
    settings = _login_config(home / "settings.json")
    plaintext = settings.get("storeTokenPlaintext", settings.get("store_token_plaintext", config.get(
        "storeTokenPlaintext", config.get("store_token_plaintext", False),
    )))
    if not isinstance(plaintext, bool):
        raise RuntimeError("Invalid Copilot credential-storage setting; run copilot login again")
    secret_tool = shutil.which("secret-tool")
    if not plaintext and secret_tool:
        for attribute in ("username", "account"):
            try:
                result = subprocess.run(
                    [secret_tool, "lookup", "service", "copilot-cli", attribute, account],
                    capture_output=True, text=True, timeout=10,
                )
            except (OSError, subprocess.TimeoutExpired):
                raise RuntimeError("Copilot keychain lookup failed; unlock the keyring and run copilot login") from None
            if result.returncode == 0 and result.stdout.strip():
                return _reviewer_credential(result.stdout.strip())
            if result.returncode not in (0, 1) or result.stderr.strip():
                raise RuntimeError("Copilot keychain lookup failed; unlock the keyring and run copilot login")
    tokens = config.get("copilotTokens", config.get("copilot_tokens", {}))
    if not isinstance(tokens, dict):
        raise RuntimeError("Invalid Copilot login configuration; run copilot login again")
    if account in tokens:
        return _reviewer_credential(tokens[account])
    raise RuntimeError(
        "Saved Copilot credential unavailable; run copilot login on this runner. "
        "For a Linux keychain login, install libsecret-tools and unlock the keyring."
    )


def copilot_archive():
    cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "reviewbench-copilot"
    archive = cache / f"copilot-linux-x64-{COPILOT_VERSION}-{COPILOT_SHA256}.tar.gz"
    with _download_lock:
        cache.mkdir(parents=True, exist_ok=True)
        if archive.exists():
            with archive.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if digest != COPILOT_SHA256:
                raise RuntimeError(f"Cached Copilot CLI checksum mismatch: {archive}")
            return archive
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as output:
            temporary = Path(output.name)
        try:
            with urllib.request.urlopen(COPILOT_URL, timeout=120) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            with temporary.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if digest != COPILOT_SHA256:
                raise RuntimeError("Downloaded Copilot CLI checksum mismatch")
            temporary.replace(archive)
        finally:
            temporary.unlink(missing_ok=True)
    return archive


class NativeCopilotReview(BaseAgent):
    @staticmethod
    def name():
        return "copilot-native-review"

    def version(self):
        return COPILOT_VERSION

    async def setup(self, environment):
        result = await environment.exec(command="uname -sm", timeout_sec=30)
        if result.return_code or result.stdout.strip() != "Linux x86_64":
            raise RuntimeError("Native Copilot review requires a Linux x86-64 reviewer image")
        archive = await asyncio.to_thread(copilot_archive)
        await environment.upload_file(archive, "/tmp/reviewbench-copilot.tar.gz")
        result = await environment.exec(
            command=(
                'test "$(git -C /work/repo rev-parse HEAD)" = "${RB_HEAD:?Frozen PR head required}"'
                ' && git -C /work/repo update-ref refs/heads/main "${RB_BASE:?Frozen PR base required}"'
                " && tar -xzf /tmp/reviewbench-copilot.tar.gz -C /usr/local/bin"
                " && rm /tmp/reviewbench-copilot.tar.gz"
                " && copilot --no-auto-update --version"
            ),
            timeout_sec=120,
        )
        if result.return_code:
            raise RuntimeError(f"Native Copilot reviewer setup failed: {result.stderr or result.stdout}")
        lines = result.stdout.splitlines()
        if not lines or lines[0].strip() != f"GitHub Copilot CLI {COPILOT_VERSION}.":
            raise RuntimeError(f"Pinned Copilot CLI version mismatch: {result.stdout!r}")
        await environment.upload_file(Path(__file__).with_name("native_review.py"), "/tmp/native_review.py")

    async def run(self, instruction, environment, context):
        token = await asyncio.to_thread(reviewer_token)
        result = await environment.exec(
            command="python3 /tmp/native_review.py", env={"COPILOT_GITHUB_TOKEN": token},
            timeout_sec=2400,
        )
        Path(self.logs_dir, "runner-output.txt").write_text((result.stdout or "") + (result.stderr or ""))
        if result.return_code:
            raise RuntimeError(f"Native Copilot review failed with exit code {result.return_code}")
        proof = await environment.exec(command="cat /logs/agent/native-proof.json", timeout_sec=30)
        if proof.return_code:
            raise RuntimeError("Native review proof missing")
        data = json.loads(proof.stdout)
        if not data["native_dispatch"] or not data["review_tool_success"]:
            raise RuntimeError("Native review was not verified")
        self._parsed_model_name = data["models"][-1] if data["models"] else None
        self._parsed_model_provider = "github-copilot"
        context.n_output_tokens = data["output_tokens"]
