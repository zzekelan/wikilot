# Wikilot

Personal desktop agent for local knowledge work.

## Send Your Agent for a Quick Start

```text
Read this guidance:
https://raw.githubusercontent.com/zzekelan/wikilot/dev/docs/quick-start/quick-start.md
```

## Install

Install Node.js 22.18 or newer, then run this command in the cloned repository
to install dependencies, register the command, and open Wikilot:

```bash
npm run setup
```

Setup installs dependencies, registers the `wikilot` command, and opens the app.

After that, start Wikilot from any directory:

```bash
wikilot
```

The local service starts and opens Wikilot in your default browser. Keep the
terminal open; press Ctrl+C to stop the service. Closing the browser tab does
not stop it. To remove the command, run `npm unlink --global wikilot`.

The command uses the existing Vite browser host and requires the repository
and its dependencies to remain installed.
