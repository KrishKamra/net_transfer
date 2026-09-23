# Security

> [!CAUTION]
> NetTransfer is a localhost lab. It has no TLS, on purpose, so a capture can still read `AUTH`, `STOR`, and `RETR`. It is not safe to expose beyond your own machine. File bytes on port 2121 are visible to anyone who can see that traffic.

> [!WARNING]
> A Wireshark capture of port 2121 contains the `AUTH` line in cleartext. Do not commit that capture, and do not use a password you use for anything else.

## Reporting

Write to the course staff who supervise the lab. Include the file you think is wrong, what you ran, and what you observed. Do not open a public issue for a report that includes a working password, a token, or a step-by-step way to leave the sandbox.

If you are a classmate and the finding is a broken check rather than something that exposes another student, a private note to the authors is enough. Give them time to read it before you describe it in a shared channel.

## What is in place

- Account passwords are stored as bcrypt hashes with 12 rounds. Login compares the hash. The raw password is not written to SQLite.
- After TCP `AUTH`, file commands resolve inside `apps/server/storage/users/<account>/`. A path that resolves outside that directory is rejected with `553`.
- HTTP delete uses the same idea: the resolved path must stay under the account directory.
- The control plane requires a Bearer token on file and transfer routes. Tokens expire after 24 hours.
- Sign-in stores the password in process memory under the token id. Upload and download use that copy to `AUTH` the TCP session. Sign-out deletes it. A client that never signed in through this process can still pass `X-Password`. A stolen token can open `STOR` until the token expires or the process restarts, because the password is held for that token.

## What is not protected

These are properties of the lab as it is built. They are listed so nobody mistakes the project for a service that can hold real data.

- The TCP session and the HTTP API are cleartext. A capture on ports 2121 and 8000 shows commands, passwords, and file bytes. That visibility is part of the later Wireshark milestone. It is also why the service must stay on loopback.
- The browser stores the JWT in `sessionStorage`, not the password. An XSS bug can still steal the token and, with it, the TCP session until expiry. Do not put a password you use anywhere else into this app. Set `NETTRANSFER_JWT_SECRET` (32 characters or more) if tokens should survive a restart. Otherwise the signing key is random per process and is not in the source tree. Anyone who learns that key can forge a token.
- The control plane counts an upload into a spool before `STOR` begins. Up to 1 MiB stays in memory. Anything larger is a temp file on the API process.
- `STOR` takes the last field as the size, so a name may contain spaces. A slash or `..` is rejected. A client that speaks TCP directly can still attempt other names, and the sandbox check still applies.
- HTTP delete removes files. It does not remove directories, and a successful response for a directory means the directory was left as it was.
- There is no rate limit on `REGISTER`, `AUTH`, or login.
- `/ws/transfers` takes the JWT in the first text frame, not in the URL. Do not put this service on a shared network. The TCP `AUTH` line is still cleartext.

## Running it

Bind the lab to loopback when you can. The TCP server defaults to `0.0.0.0`, which accepts connections from other machines on the network. For a capture on your own laptop, `127.0.0.1` is the right peer.

Do not point this tree at a shared drive of real files. Sandboxes under `apps/server/storage/users/` are ordinary directories with the permissions of the user who started the server.

## Scope of a fix

A change that closes one of the items above should say which threat it removes and which lab behavior it keeps. Adding TLS or a real secret store is out of scope unless the course asks for it. Tightening the sandbox check, stopping a password from being logged, or refusing a path that resolves outside the account directory is in scope.
