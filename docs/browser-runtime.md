# Browser-focused runtime — October 7, 2026

Blots now starts Docker Desktop quietly on demand on macOS. Starting the app or asking a text-only question does not start Docker. Starting a Linux desktop or building its image checks for the runtime; if Docker is stopped, Blots launches it hidden and in the background, waits for readiness, and then starts the requested computer. Concurrent desktop starts share that startup attempt. Docker remains an installed background dependency, and first-run setup, updates, or other required confirmations can still need attention.

The small **Close computer** button beside Expand stops that bot's current task and Linux computer. Its files remain available for the next start. A normal native-app quit waits for active tasks and all computers belonging to this Blots installation, including running computers left from an earlier session. Viewer reconnects cannot restart a closed computer. Docker Desktop's VM also stops when Blots used it and no other containers are running; unrelated Docker workloads keep it alive.

Native quit requests model unloading when the local server advertises `capabilities.unload_model`. The development Mac's Splash gateway implements `/v1/unload-model`: it releases the resident Splash process used by Blots, waits for other active gateway requests, and leaves its lightweight gateway available for the next launch. Other providers without this capability manage their own model lifetime. Cleanup failures keep quit pending and display an error so they can be resolved and retried. Force Quit, crashes, and power loss cannot run this graceful cleanup.

The installed Mac app was verified on October 7, 2026 with three running Linux computers and a loaded Splash 35B model. All three computers exited with code 0, including one started outside the app's tracked session; the model process exited and Docker's VM stopped. Seven shutdown regression tests cover cancellation, repeated Quit, cleanup retry, model unloading and stale viewer reconnects.

## Desktop resources

Settings has CPU and memory sliders. Each computer defaults to **one CPU core and 1 GiB RAM**, with ranges of 1–4 cores and 1–4 GiB in half-GiB memory increments. Save desktop limits, then stop and start a computer to apply them. Existing computers update their limits without deleting their home directory, browser profiles, or workspace. A limit is a ceiling, not guaranteed use or a reserved share. Complex pages or several extra screens can need a higher limit; use 1.5–2 GiB if Chromium becomes unstable.

Docker’s shared VM and the native Splash inference process have separate budgets. On this Mac, the shared Docker VM is configured for 18 CPUs and 8 GiB; those global settings were retained because they also govern other Docker workloads. The Blots sliders constrain each bot inside it. Installed Linux apps consume disk space but do not run simply because their launchers are visible. Model generation is serialized; three bots do not mean three resident model copies.

## Checks on this Mac

- Before reducing the per-desktop ceiling, an isolated computer became ready in 1.936 seconds. Samples after readiness fell from 46.09% to 8.87%, 2.78%, then 0.78–1.11% CPU. Docker reports 100% as one core. Initial working-set samples were approximately 751–758 MiB, excluding Docker VM overhead and the native model.
- The installed native app started Azul’s desktop with Docker Desktop stopped. The desktop became live without bringing Docker’s dashboard forward. Container inspection confirmed a 1,073,741,824-byte RAM ceiling and 1,000,000,000 NanoCPUs (one core).
- With a live viewer, Azul’s idle computer sampled 0.80% CPU and 700.7 MiB. This is one sample, not a universal idle-memory guarantee.
- A separate desktop at the 1-core/1-GiB limits opened a Google internship search and a Wikipedia article through the real address bar and read their content successfully. Samples during/after page loading showed 439.2 and 536.4 MiB, with no observed browser crash. This is not an exhaustive test of heavy recruiting portals or many tabs.
- Native sliders incremented to 2 cores / 1.5 GiB, saved successfully, and were restored and saved at the light defaults. Automated validation rejects unsupported values and preserves saved settings.
- No sustained fan burst was reproduced in this check, and fan RPM was not measured. CPU-core count does not establish thermal load. Native model inference, long prompt processing, changing web pages, and other apps can contribute; the measured idle desktop alone did not show sustained high CPU.

## Reasoning check

Splash’s output budget counts thinking as well as visible output. An actual 27B request with a deliberately tiny 64-token budget ended with `length`, 64 reasoning tokens and no visible answer. The previous Blots default was 4,096 total output tokens, and its stream reader discarded `reasoning_content` between tools.

The update retains the reasoning field for the next tool turn and checkpoint, requests usage counters, and asks the verified Splash packages to preserve thinking. Defaults are 16,384 output tokens and a 65,536-token task context budget. Fixed 12-turn compaction was removed; context compaction now follows pressure. Existing custom output limits remain, while the former 4,096 default for the verified installed Splash models is migrated once.

An actual 27B Medium reasoning test returned a verification tool call with 665 reasoning tokens, then received the verified dependency schedule along with its returned reasoning and completed with the correct 12-hour makespan. Neither response hit its ceiling. This checks the integration, not representative long-horizon task intelligence. Browser research instructions now favor the existing visible browser tools and page-text reading, using screenshots for blocked pages or unclear controls instead of requesting one after every ordinary action. These browser actions still drive the real Linux mouse and keyboard, so the live desktop remains observable. Larger context and output budgets can increase latency and heat; the model and task still need finite, configurable ceilings.
