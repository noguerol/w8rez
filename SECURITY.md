# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✓ |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Open a GitHub security advisory via **Security → Report a vulnerability** on
this repository, or contact the maintainers through the contact listed in the
repository settings. Include:

- affected version (or commit),
- a minimal reproduction (input file, request, or page interaction),
- impact assessment.

You can expect an initial response within 7 days. We will credit reporters in
the release notes unless they prefer to remain anonymous.

## Scope notes

- The conversion endpoints (`/api/*`) accept file uploads and hand them to
  ghostscript/ffmpeg. Memory-safety issues inside those upstream tools are in
  scope for us only where w8rez can mitigate them (sniffing, caps, timeouts,
  sandboxing guidance) — tool bugs themselves should also be reported
  upstream.
- The server is designed to run on the loopback interface without
  authentication. "Remote attacker" reports require a non-default
  configuration (`W8REZ_HOST`) or an attacker already running code on the
  machine.
