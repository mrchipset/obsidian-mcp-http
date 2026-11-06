# Security policy

## Supported versions

The latest 2.x release is supported. Version 1.x is deprecated and contains known path-containment defects.

## Reporting a vulnerability

Do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting feature for this repository and include:

- affected version and platform;
- a minimal reproduction using a disposable vault;
- expected and observed behavior;
- impact and any known mitigations.

Avoid including real vault contents or personal filesystem paths. Maintainers should acknowledge a complete report within seven days and coordinate disclosure after a fix is available.

## Security boundary

An explicit `--vault id=/absolute/path` grants this local process read/write access to that root. MCP tool paths must remain within it. The server does not authenticate local stdio clients; the launching MCP host controls who can invoke the process and which vault arguments it receives.

The Streamable HTTP transport is an explicit opt-in (`--transport http`) and binds to loopback by default. `Host` and `Origin` headers are validated against loopback names, rejecting unexpected values with HTTP 403 to block DNS-rebinding attacks. HTTP clients are not authenticated unless `--auth-token`, `OBSIDIAN_MCP_HTTP_TOKEN`, or `MCP_API_KEY` is configured; configure a bearer token and place the endpoint behind a reverse proxy that terminates TLS before exposing it beyond the local machine. HTTP request bodies are capped at 10 MiB (the same limit as the stdio buffer), `Host` and `Origin` checks run before authentication, and 2025-era clients are served per request without session state. Prefer a reverse proxy that also enforces its own request-size and rate limits. Allowed origins are matched by hostname only, ignoring scheme and port, so the bearer token is the only defense against other local web pages; buffering and request classification can temporarily use a few times the body cap per concurrent request.

The HTTP transport also exposes read-only vault file resources and `POST /upload`. Both reuse the tool path validation (vault-relative only, no symlinks or reserved roots). Uploads require the bearer token even when the MCP endpoint is unauthenticated, accept only PNG, JPEG, WebP, GIF, SVG, and PDF, are capped by `UPLOAD_MAX_BYTES` (20 MiB by default), create missing parent directories, and write through a same-directory temporary file before an atomic rename with `0644` permissions on POSIX. Resource reads are read-only and capped by `RESOURCE_MAX_BYTES` (10 MiB by default); content above the cap returns a protocol error instead of a partial file.
