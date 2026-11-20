# Peer integration

- Keep Codex on the existing canonical shared AppServer. Reuse `validateSharedRuntime`, `connectCanonical`, and the existing Desktop delivery route. Never start an isolated server or resume a loaded task to take ownership.
- Use exact thread/session and turn identities, preserve existing settings and stops, and retain dispatch/UNKNOWN journals without automatic resend. An empty pre-first-message thread and persisted history are different states.
- Completion notifications and persisted history can arrive at different times. Report the target's actual terminal state; do not classify a transient `inProgress` projection as failure or success.
- Keep host skills in `skills/`, transport in the modules here, operational explanation in `../docs/claude-codex-collaboration.md`, and raw executions in ignored `../state/agent-collaboration/`. Preserve upstream Apache-2.0 attribution.
- Mobile integration uses official Claude Remote Control with the user's subscription, official consent, and normal permissions. Do not change Codex/Discord, extract credentials, enable automatic Windows sign-in, or install unrelated services.
