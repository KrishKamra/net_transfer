# Contributing

NetTransfer is a computer-networks course project. Changes should keep the TCP session, the control plane, and the UI describing the same transfer.

> [!IMPORTANT]
> Run the TCP server, the control plane, and the web app together before you call a transfer done. A green page with a dead port 2121 is not a passing upload.

## Setup

Install both sides once. From the repository root:

```text
cd apps/server
uv sync

cd ../web
pnpm install
```

Python 3.11 or newer is required. The server project is managed with uv. The web app uses pnpm.

Run all three processes while you work. Details and ports are in the [README](README.md).

```text
uv run python -m src.networking.tcp_server
uv run uvicorn src.main:app --port 8000
pnpm dev
```

The first two commands run in `apps/server`. `pnpm dev` runs in `apps/web`.

## Where code lives

| Area | Path | Touch it when |
| --- | --- | --- |
| Framing | `apps/server/src/networking/protocol.py` | Line framing or the 8-byte length prefix changes |
| TCP session | `apps/server/src/networking/tcp_server.py` | A command, reply code, or sandbox rule changes |
| CLI | `apps/server/src/networking/client.py` | The interactive `PUT` / `GET` client changes |
| HTTP bridge | `apps/server/src/networking/tcp_client_bridge.py` | FastAPI must drive `STOR` or `RETR` differently |
| HTTP routes | `apps/server/src/api/routes.py` | A REST path, header, or status changes |
| Accounts and rows | `apps/server/src/storage/db.py` | The SQLite schema or queries change |
| Shared paths | `apps/server/src/storage/layout.py` | The sandbox root or the database path changes |
| Transfer metrics | `apps/server/src/transfer/manager.py` | Speed, ETA, or recorded status changes |
| UI | `apps/web/src` | Sign-in, the sandbox, or progress cards change |

Keep `USER_STORAGE_DIR` as the only sandbox root. The TCP process and `GET /api/files` must list the same directory. A relative path that depends on the shell's working directory will split them again.

## Protocol rules

These are easy to break while a change looks locally fine.

- Commands are one UTF-8 line ending in `\n`. Reply codes stay the three-digit codes already used (`150`, `226`, `530`, `553`, and the rest listed in the README).
- `STOR <filename> <size>` uses the last field as the size. The name may contain spaces. Slashes and `..` are still rejected.
- After `150` on `STOR`, the next bytes are the file, with no extra header. The count must match the declared size.
- After `150` on `RETR`, the next 8 bytes are an unsigned big-endian length, then exactly that many payload bytes, then a `226` line.
- A resolved path must stay inside the account directory. `..`, absolute paths, and prefixes that only look similar are not inside the sandbox.
- Passwords are stored as bcrypt hashes. Do not log the raw password or write it into SQLite.

If you add a command, update the TCP server, the interactive client if humans should type it, and this behavior in the README.

## UI rules

The web app is the control surface for the lab, not a separate product.

- Talk to the API through `apps/web/src/lib/api.ts`. Upload progress uses `XMLHttpRequest` because `fetch` does not report upload progress. Download progress reads the response body.
- Send `Authorization: Bearer` on authenticated calls. The browser does not send the password again. A non-browser client may still pass `X-Password` if the server has no remembered login.
- A filename that `STOR` cannot carry should fail in the browser before the request starts. See `storFilenameError` in `apps/web/src/lib/filenames.ts`.
- Progress copy should say which hop is moving. The bar measures HTTP. `STOR` and `RETR` are the wait on TCP.
- Keep the file table flat and readable. Status color is for outcome and for bytes in flight, not for decoration.

## Screenshots

With the three processes already running, from `apps/web`:

```text
pnpm exec playwright install chromium
node e2e/capture.mjs
```

Frames land in `docs/screenshots/`. Set `NT_USER` and `NT_PASS` to an account that already exists if you do not want the script to sign into `labshot`.

## Checks

Web typecheck and build, from `apps/web`:

```text
pnpm exec tsc --noEmit
pnpm build
```

Server tests, from `apps/server`:

```text
uv run pytest
```

Pytest is configured. The `tests` directory does not have cases yet. A change to framing, auth, or the sandbox should add a test there rather than only a manual session.

Before you call a transfer done, exercise it on the real sockets: TCP server, control plane, and either the CLI or the UI. An upload that never appears in `GET /api/files` means the two processes are not sharing `USER_STORAGE_DIR`.

## Changes

Keep a change to one concern. A protocol fix does not need a visual redesign. A UI change should not retune reply codes.

Write commit messages as a short statement of what changed for someone reading the history later. Mention the command or the route when that is the thing that changed.

Do not commit `apps/storage/nettransfer.db`, files under an account sandbox, `node_modules`, or `apps/web/dist` unless the task is specifically to publish a fixture. Secrets do not belong in the tree. Do not commit a real `NETTRANSFER_JWT_SECRET`. When that variable is unset, the process generates its own key.

## Conduct

Discussion on issues and reviews follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports follow [SECURITY.md](SECURITY.md), not a public issue.
