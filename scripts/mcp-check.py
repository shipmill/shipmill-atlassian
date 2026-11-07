# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp>=1.9,<2"]
# ///
"""Call the Jira app's MCP tools from outside Atlassian, as Claude Code would.

    uv run scripts/mcp-check.py list HRB [2.4]
    uv run scripts/mcp-check.py ask HRB-2 2.4
    uv run scripts/mcp-check.py answer HRB-2

The first run prints an AUTHORIZE url: open it, sign in, pick the site and allow access; the
browser then lands on a local callback this script listens on. The OAuth client and its
tokens stay in tmp/mcp-check-state.json (git-ignored, mode 600); delete it to sign in again.
An access token lasts eight hours; a later run trades the saved refresh token for a new one,
so the sign-in is needed only once.
Tool names carry the environment's suffix (`_development` from `forge deploy -e development`),
so --suffix picks another environment. See README, "Ask from a coding agent through MCP".
"""

import argparse
import asyncio
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

import httpx
from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

APP_ID = "e68108c0-f2e4-427b-9417-b3878322c288"
SERVER = f"https://mcp.atlassian.com/forge/{APP_ID}"
PORT = 33419
STATE = Path(__file__).resolve().parent.parent / "tmp" / "mcp-check-state.json"


class FileStorage(TokenStorage):
    def _load(self) -> dict[str, object]:
        return json.loads(STATE.read_text()) if STATE.exists() else {}

    def _save(self, key: str, value: object) -> None:
        data = self._load()
        data[key] = value
        STATE.parent.mkdir(exist_ok=True)
        STATE.write_text(json.dumps(data))
        STATE.chmod(0o600)

    async def get_tokens(self) -> OAuthToken | None:
        raw = self._load().get("tokens")
        return None if raw is None else OAuthToken.model_validate(raw)

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._save("tokens", tokens.model_dump(mode="json"))
        # The MCP client forgets when a stored token expires, so a run after that would sign in
        # again instead of refreshing; keep the expiry next to the token
        expires_in = 0 if tokens.expires_in is None else tokens.expires_in
        self._save("expires_at", time.time() + expires_in)

    def expires_at(self) -> float:
        # A state file from before the expiry was kept counts as expired, so it is refreshed
        raw = self._load().get("expires_at", 0)
        if not isinstance(raw, (int, float)):
            raise ValueError(f"expires_at in {STATE} is not a number: {raw!r}")
        return float(raw)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        raw = self._load().get("client")
        return None if raw is None else OAuthClientInformationFull.model_validate(raw)

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._save("client", client_info.model_dump(mode="json"))


callback: dict[str, str] = {}


class Callback(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        callback.update({key: values[0] for key, values in parse_qs(urlparse(self.path).query).items()})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"shipmill: authorized, you can close this tab")

    def log_message(self, *args: object) -> None:
        pass


async def show_authorize_url(url: str) -> None:
    print(f"AUTHORIZE {url}", flush=True)


async def wait_for_callback() -> tuple[str, str | None]:
    server = HTTPServer(("127.0.0.1", PORT), Callback)
    Thread(target=server.handle_request, daemon=True).start()
    while "code" not in callback and "error" not in callback:
        await asyncio.sleep(0.5)
    if "error" in callback:
        raise RuntimeError(f"authorization failed: {callback}")
    return callback["code"], callback.get("state")


async def refresh_if_expired(storage: FileStorage) -> None:
    """Trade the saved refresh token for a new access token once the saved one has expired.

    The SDK refreshes only a token it knows has expired, and it learns that only from a token it
    got in the same process; after a restart it sends the expired token, gets 401 and starts a new
    sign-in. Its refresh also posts to the MCP server's own /token, while this server names
    another authorization server (auth.atlassian.com) in its protected resource metadata.
    """
    tokens = await storage.get_tokens()
    client = await storage.get_client_info()
    if tokens is None or client is None or tokens.refresh_token is None:
        return
    if time.time() < storage.expires_at() - 60:
        return
    resource_path = SERVER.removeprefix("https://mcp.atlassian.com")
    async with httpx.AsyncClient(timeout=30) as http:
        resource = await http.get(f"https://mcp.atlassian.com/.well-known/oauth-protected-resource{resource_path}")
        resource.raise_for_status()
        issuer = resource.json()["authorization_servers"][0]
        host, _, tenant = issuer.removeprefix("https://").partition("/")
        metadata = await http.get(f"https://{host}/.well-known/oauth-authorization-server/{tenant}")
        metadata.raise_for_status()
        form = {"grant_type": "refresh_token", "refresh_token": tokens.refresh_token, "client_id": client.client_id, "resource": SERVER}
        if client.client_secret is not None:
            form["client_secret"] = client.client_secret
        response = await http.post(metadata.json()["token_endpoint"], data=form)
    if response.status_code != 200:
        raise SystemExit(f"refreshing the saved token failed ({response.status_code}); delete {STATE} to sign in again")
    refreshed = OAuthToken.model_validate_json(response.content)
    if refreshed.refresh_token is None:
        refreshed = refreshed.model_copy(update={"refresh_token": tokens.refresh_token})
    await storage.set_tokens(refreshed)
    print("REFRESHED the saved access token", flush=True)


def tool_call(args: argparse.Namespace) -> tuple[str, dict[str, str]]:
    if args.command == "list":
        return "list-release-decisions", {"project": args.target} | ({} if args.version is None else {"version": args.version})
    if args.command == "ask":
        if args.version is None:
            raise SystemExit("ask needs the fix version: ask HRB-2 2.4")
        return "ask-decision", {"issueKey": args.target, "version": args.version}
    return "read-decision-answer", {"issueKey": args.target}


async def main(args: argparse.Namespace) -> None:
    storage = FileStorage()
    await refresh_if_expired(storage)
    auth = OAuthClientProvider(
        server_url=SERVER,
        client_metadata=OAuthClientMetadata(
            client_name="shipmill mcp-check",
            redirect_uris=[f"http://localhost:{PORT}/callback"],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
        ),
        storage=storage,
        redirect_handler=show_authorize_url,
        callback_handler=wait_for_callback,
    )
    action, arguments = tool_call(args)
    name = f"{action}{args.suffix}"
    async with streamablehttp_client(SERVER, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = [tool.name for tool in (await session.list_tools()).tools]
            print(f"TOOLS {', '.join(tools)}", flush=True)
            if name not in tools:
                raise SystemExit(f"{name} is not offered; is the app deployed to this environment and exposed by the admin?")
            result = await session.call_tool(name, arguments)
            text = "\n".join(content.text for content in result.content if content.type == "text")
            print(f"CALL {name} {json.dumps(arguments)} isError={result.isError}\n{text}", flush=True)
            if result.isError:
                raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["list", "ask", "answer"])
    parser.add_argument("target", help="a project key for list, a work item key for ask and answer")
    parser.add_argument("version", nargs="?", help="the fix version (optional for list)")
    parser.add_argument("--suffix", default="_development", help="the environment's tool name suffix")
    asyncio.run(main(parser.parse_args()))
