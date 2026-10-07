# Blots

**Your own little team.** A blue, local AI desktop app for Apple silicon Macs. Each bot has its own persistent Linux computer with four live screens. Chat beside the computer, watch it research, or take over its mouse and keyboard.

Blots is independently built software, not a fork of Bops. There is no Blots account, inference subscription, telemetry, or hosted backend. Inference and app data stay on your Mac. Web research connects to the websites you ask your bots to visit.

![Blots](docs/preview.png)

## Run on your Mac

1. Open Docker Desktop and wait for it to finish starting. No Docker account is required to run local containers.
2. Run an OpenAI-compatible **local model server** with a tool-capable model loaded. Blots defaults to `http://127.0.0.1:8000/v1`. The app selects the first available model on first launch; change it in Settings. Ollama commonly uses `http://127.0.0.1:11434/v1`; LM Studio commonly uses `http://127.0.0.1:1234/v1`.
3. Open **Blots.app**. Click **Start computer** beside your bot. On a fresh machine, first choose **Settings → Build computer image**. This downloads and builds the Linux desktop once; subsequent starts use the local image.
4. Ask a bot to research a topic, draft a document, or organize files. Review requested writes and browser interactions. Click **Take over** to drive its real desktop; **Hand back** or Escape returns control.

The supplied Mac app bundles its own Electron/Node runtime. You do not need Node to launch it. Docker Desktop and the local inference server are separate prerequisites; model weights are not included.

## Build from source

Requirements: an Apple silicon Mac, Node 22+, npm, Docker Desktop, and a local model server supporting `/v1/models`, `/v1/chat/completions`, streaming, and function calls.

```sh
git clone https://github.com/anujk22/blots.git
cd blots
npm ci
npm run computer:build
npm start
```

For the native app:

```sh
npm run build
open dist/mac-arm64/Blots.app
```

For browser-based development: `npm run dev`, then open `http://127.0.0.1:4317`. The packaged desktop chooses an available loopback port automatically.

The desktop is built locally and unsigned for distribution; it is not a notarized App Store release.

## What works

- Multiple named bots with editable roles, instructions, and colors. Bots can delegate tasks to teammates; delegated tasks appear in their own conversations and use the same local inference queue.
- Persistent conversations with streamed local model responses.
- Live web search, real browser navigation, page reading, and numbered browser actions. Research bots can open sources and cite URLs; no paid search API is needed.
- A real Linux computer per bot: Chromium, terminal, file manager, and text editor. Four independent screens, browser profiles, and persistent home directories.
- Live VNC viewing, screen previews, expansion, and mouse/keyboard takeover. Agent tools wait while you have control of their screen.
- Local workspace listing, reading, file creation/editing, and downloads. File writes, saved memories, browser clicks/typing, and Linux commands come to you for review.
- Durable local memory shared among bots, managed by you.
- Scheduled routines, created in the app or requested in chat, while the app is open. Results appear in their own conversations; reviewed actions still wait for you.
- Tool activity, cancellation, error recovery, data export, and local server/model settings.
- Optional screenshot-based native app tools for **vision-capable** local models. Enable these in Settings. Ordinary browser research uses page text and works without vision.

## Tuned for Apple silicon

The Mac app and Linux image run natively on ARM64. Models run in your existing local server, not in Docker. Blots queues inference one task at a time to avoid loading multiple model contexts simultaneously. Each desktop is limited to 2 CPUs and 2 GB RAM; at most three run at once. Four-screen desktops measured about 1.0 GB each at idle on the development M5 Pro Mac. Computers start on demand and stop when Blots quits; their data persists.

Conversation context is bounded to the most recent 24 messages and 60,000 characters. Tool results are bounded, reply length is configurable, and tasks have a configurable step limit. This avoids uncontrolled context growth; it also means very long conversations do not all fit in a single prompt. Shared memory preserves the facts you choose to save.

## Your data and boundaries

The packaged Mac app stores data in:

```text
~/Library/Application Support/Blots/
├── state.json             conversations, settings, memory, routines, activity
├── workspace/             shared files visible to you and your bots
└── computers/<bot-id>/    each computer's persistent Linux home and profiles
```

No Mac home directory, model API key, Docker socket, or system folder is mounted into a bot computer. The only Mac mounts are its own home storage and the shared Blots workspace. Linux commands run as an unprivileged user inside the computer. Workspace tools reject traversal and symlink escapes. Computers share the workspace intentionally.

The app server, desktop ports, and model connection are loopback-only. The app checks request origins and hosts; the renderer is sandboxed with Node disabled. Markdown is sanitized. API keys, when a local server needs one, stay in local settings and are excluded from exported backups. This is a single-user local app, not a multi-user remote service.

Quitting stops pending work. Reopening records interrupted tasks instead of repeating them automatically. Stopping prevents further model/tool steps; an already executing Linux command may finish or reach its 30-second limit. A task can run for up to 30 minutes before it is stopped. Restart with a follow-up message to continue from completed work.

## Practical limits

Local model quality determines reasoning, tool selection, vision, and task success. Blots does not claim parity with proprietary frontier models. Websites can require sign-in, present CAPTCHAs, or restrict automation; take over when they need you. Search uses ordinary websites and remains subject to their availability. Voice calls, phone numbers, email provisioning, paid connector catalogs, and controlling arbitrary Mac apps are not included. Routines do not run while Blots or the Mac is off.

The Linux computers are containers inside Docker Desktop's local Linux VM, not separate hardware VMs. The code is MIT licensed; dependencies retain their own licenses, including noVNC's MPL-2.0 license.

## Verification

```sh
npm test
npm audit --omit=dev
```

Automated tests cover local-only inference routing, file confinement, fragmented streams, approval before execution, denial/cancellation, persistence, exports without credentials, inference queuing, and takeover pause/hand-back. The app also underwent live UI and Docker checks plus actual local-model file creation and source-reading tasks.
