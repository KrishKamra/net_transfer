## Summary

Say what changed for someone reading the history later. Name the command or the route when that is the thing that moved.

## Area

TCP file service, control plane, web UI, or docs. One concern per change.

## How you checked it

Which of the three processes were running, and what you uploaded, downloaded, or listed. An upload that never appears in `GET /api/files` means the TCP server and the control plane are not sharing `USER_STORAGE_DIR`.

## Protocol and sandbox

If framing, reply codes, or path checks changed, say what a capture or a `STOR` / `RETR` session shows now. The account directory stays `apps/server/storage/users/<account>/`.

## Checklist

- [ ] No passwords, tokens, `.env` secrets, packet captures, or account sandbox files
- [ ] No `apps/storage/nettransfer.db`, `node_modules`, or `apps/web/dist`
- [ ] README still matches the command or route, when one of those changed
- [ ] A framing, auth, or sandbox change adds a test under `apps/server/tests` when that is practical
