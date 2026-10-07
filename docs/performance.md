# Blots resource audit — October 7, 2026

The largest avoidable cost was starting all four Linux screens, including four independent Chromium instances, for every bot. Computers now start only Desktop 1; additional screens start when viewed or used by a tool. The four-screen feature remains available.

## Measurements on the development M5 Pro Mac

Three separate bot computers were started together, allowed to settle for ten seconds, then sampled with `docker stats --no-stream`. The baseline was commit `830a287`. These are container working-set measurements, excluding the Mac app, Docker VM overhead, and the separate Splash model server. Browser pages and native applications can increase usage.

| Measurement | Before | After |
| --- | ---: | ---: |
| Three idle PCs combined | 3.537 GiB | 1003.2 MiB / 0.980 GiB |
| Idle memory per PC | 1.166–1.193 GiB | 333.6–335.1 MiB |
| Startup of each PC, observed | 3.25–3.26 seconds | 1.89–1.99 seconds |
| Processes/threads across three PCs | 2074 | 529 |
| Fresh persistent home per PC, approximate | 25 MiB | 7.6 MiB |

Combined idle PC memory fell approximately 72%. Startup times are one local comparison with already-built images, not a universal latency guarantee. A PC with all four screens open measured about 1.2 GiB, as expected: unused screens are deferred, while screens the user opens retain their state until the computer stops.

## Runtime changes

- Different bots can execute computer tools concurrently. Only model generation is serialized, keeping one generation request active at a time. Turns for the same bot remain ordered to protect its mouse and browser state.
- A bot waiting for approval no longer blocks other bots. Cancellation, takeover, per-bot Auto approval, and settings snapshots retain regression coverage.
- Vision turns keep only the latest screenshot batch in subsequent model requests, avoiding repeated encoding of obsolete screen images. Screenshots are not persisted in chat state.
- Hidden desktop viewers disconnect; agent work continues. Viewing resumes on return. The VNC bridge uses stream backpressure, so a slow viewer cannot make it buffer frames without bound.
- Unchanged state polls return HTTP 304 with no body. Draft changes and transient computer control changes invalidate the response. The UI skips parsing and rendering unchanged state.
- Shell command output is drained into a bounded 96 KiB tail buffer instead of retaining the entire output. The 20,000-character response limit, exit codes, and 30-second process-group timeout remain in place. In a 128 MiB noisy-output test, guest-server peak memory increased by 384 MiB before, versus 0.27 MiB after.
- State remains atomically saved as JSON, using compact encoding. The existing local state sample changed from 24,440 to 21,448 bytes without removing its content.
- Browser HTTP disk caches are configured for 64 MiB per used screen; Electron's HTTP cache is configured for 32 MiB. Website storage and user downloads are separate. Unused Chromium component updates are disabled. Container logs rotate at two 5 MiB files.
- Cursor aliases share generated cursor files instead of duplicating them. All native pointer shapes and the agent glow/badge remain available.

## Storage and cleanup

The installed Mac app is approximately 314 MiB, mostly its bundled Electron framework. The full Linux application image is approximately 7.7 GB unpacked and is shared across bots. Splash weights live in the user's existing model server; Blots does not install another copy for each agent.

Docker reported 2.397 GB reclaimed from specifically identified obsolete Blots build-cache records. Four redundant Chromium component download caches freed another 156,166,316 bytes. Stopped test containers were removed; their bound data folders were preserved. Unrelated Docker images and volumes were left alone. The current Linux build cache remains to accelerate future desktop-image updates; Docker reported about 7.7 GB of build cache after cleanup. It is separate from the runnable image and not required for daily use.

## Verification

All 18 tests passed. The new tests cover overlapping work across three bots, serialized model generation, ordered turns for one bot, cancellation, replacement of previous screenshots, and conditional state polling.

Three concurrent tasks using the actual local Splash model (reasoning Off, 1024 maximum reply tokens) each took a Linux screenshot, moved the real mouse to their own target coordinates, and completed in approximately 33–35 seconds. All four desktops were tested, including concurrent duplicate requests for unopened screens and browser navigation on Desktop 4. Browser QA verified live VNC pixels, extra-screen startup, Activity-view suspension, hidden-window suspension, and reconnection without JavaScript errors. A forced connection drop also recovered during unchanged HTTP 304 polls. The noisy-command test verified bounded output, stderr capture, nonzero exit codes, and termination of a timed-out command with a child process. The rebuilt native app was installed and visually checked after restart.
