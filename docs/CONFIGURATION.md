# Configuration reference

w8rez needs no configuration. Every option below is an optional environment
variable read by `server.js` at startup. The browser side has no settings
file by design.

## Server options

| Variable | Default | Range | Description |
|---|---|---|---|
| `PORT` | `8080` | 0–65535 | listen port. `0` picks an ephemeral port (used by the tests); the bound URL is printed at startup. |
| `W8REZ_PORT` | — | 0–65535 | alias for `PORT`; `PORT` wins when both are set. |
| `W8REZ_HOST` | `127.0.0.1` | any | bind address. Loopback by default; binding anything else prints an explicit exposure warning. |
| `W8REZ_ALLOWED_HOSTS` | *(hostname)* | CSV | extra `Host` header values accepted (e.g. a local domain used in a container setup). |
| `W8REZ_MAX_UPLOAD_MB` | `30` | 1–512 | request body cap for conversion endpoints. |
| `W8REZ_MAX_OUTPUT_MB` | `256` | 1–2048 | conversion output cap; passed to ffmpeg as `-fs` and enforced before streaming gs output. |
| `W8REZ_MAX_CONCURRENT` | `2` | 1–16 | concurrent conversion jobs. Extra requests queue; beyond the queue they get `503`. |
| `W8REZ_MAX_QUEUE` | `8` | 0–64 | queued requests allowed once the concurrency slots are full. |
| `W8REZ_GS_TIMEOUT_S` | `60` | 5–600 | hard timeout for ghostscript runs. |
| `W8REZ_FFMPEG_TIMEOUT_S` | `180` | 5–1800 | hard timeout for ffmpeg runs. |
| `W8REZ_BODY_TIMEOUT_S` | `120` | 5–1800 | max time to receive an upload. |
| `W8REZ_DISABLE_TOOLS` | *(unset)* | CSV | `gs`, `ffmpeg` and/or `all`. Disabled endpoints answer `501`. Use this if you do not need those formats or do not want the tools executed at all. |
| `W8REZ_H264_ENCODER` | *(auto)* | name | Force a specific H.264 encoder for the MP4 endpoints. By default w8rez probes the ffmpeg build once and uses the first available of `libopenh264`, `libx264`. |
| `W8REZ_LOG` | off | `1` | request log lines to stdout (`method path → status ms`). |

### Examples

```bash
# default: loopback, tools enabled
node server.js

# a specific port with request logging
PORT=3000 W8REZ_LOG=1 node server.js

# static file server only (no external tools, ever)
W8REZ_DISABLE_TOOLS=all node server.js

# container usage (mind the exposure warning)
W8REZ_HOST=0.0.0.0 PORT=8080 node server.js
```

## External tools

| Tool | Required for | Without it |
|---|---|---|
| ghostscript (`gs`) | EPS conversion; PDF→PNG fallback | EPS falls back to the embedded JPEG preview; PDF still renders via the vendored pdf.js |
| ffmpeg | transcoding non-playable videos; MP4 export | only browser-native video formats load; MP4 export disabled (WebM/HTML still work) |

Versions are shown at startup and via `GET /api/status`.

## Browser support

Any current Chromium- or Firefox-based browser. `MediaRecorder` (WebM
export) and `canvas.captureStream` are required for the WebM output; MP4
export additionally requires the helper server with ffmpeg.
