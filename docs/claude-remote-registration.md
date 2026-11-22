# Claude Remote Control registration persistence

Verified against the installed Claude Code 2.1.329 on SurfaceBook2, 2026-11-23 JST.

## Why 01:33 created a registration

At 01:33:53.893 JST (November 22 16:33:53.893Z), the previous debug log reports
`[remote-bridge] Created session cse_01BssPsY9uf6wywfFrPBF8eV`.
There is no preceding persisted-pointer reattach, owner veto, unarchive, or gone
fallback event. The first actual `bridge-session` record in local conversation
`5467c555-7279-5b55-b8ce-e262b1e2e1f7.jsonl` is line 1812, immediately before
the 16:33:54.437Z attachment and bridge-status event. It contains the new ID.
There is no earlier pointer or blank-pointer clear in the retained transcript.
Its recorded account/organization match the later successfully restored pointer.

The older `cse_01BssPsW3Xcxi7T7bhrdNbLW` appears earlier only in message/tool
text, not a bridge pointer. Transcript line 529, at 09:58:29.981Z, records a
separate PID 10572 running `remote-control --session-id session_01BssPsW3Xcxi7T7bhrdNbLW`
and PID 13656 running a `--print --sdk-url .../cse_01BssPsW3Xcxi7T7bhrdNbLW`
worker. Resuming the local interactive conversation does not infer a pointer
from these command strings. The 01:33 launch took the no-pointer create branch;
neither account change nor server expiry is evidenced as its cause.

The 01:38 boot launch restored the 01:33 ID and connected with epoch=2. The
visible old/new entries therefore reflect the earlier transition from standalone
server to interactive bridge, rather than another conversation registration minted
by the 01:36 reboot. The old server's final archive/deletion state is not known
from retained evidence. No credentials were read or private server probe made.
The old Haiku `session_01BssPsVCnxSoTxgVWT2Mnjt` likewise appears in historical
tool text describing conversation `b0e8fb51-a348-45e2-b28b-db99456bc7be`, not
as this interactive conversation's pointer.

## Installed implementation

- Durable pointer: `~/.claude/projects/<encoded-cwd>/<local-conversation-id>.jsonl`,
  record type `bridge-session`, keys `sessionId`, `bridgeSessionId`,
  `lastSequenceNum`, optional dialog/grouping/no-backfill fields and
  `ownerAccountUuid` / `ownerOrganizationUuid`. Both current conversations use
  project directory `C--Users-lazyg-Documents-ChatGPT----`. No token is stored here.
- Bundled `$rr` writes the transcript pointer and in-memory bridge state; `hX`
  returns it. Resume restores it. Establishment, persistence updates and exit
  persistence save it. PID records in `~/.claude/sessions/<pid>.json` advertise
  live metadata; they are not the durable pointer. cse_ and session_ are the
  internal and phone-facing forms of the same registration suffix.
- `jge` clears by appending `bridgeSessionId:"", lastSequenceNum:0` and clearing
  memory. Explicit disconnect without keepRecord, confirmed dead-pointer handling,
  teleport and relevant conversation lifecycle transitions can clear it. Normal
  exit persistence retains it. Fork strips bridge ID/sequence/grouping/owner fields.
- Interactive `--resume <id>` selects that local conversation. `--continue` selects
  the latest local conversation in the directory, which could be Haiku instead.
  A new/forked conversation has no inherited pointer. Interactive `--session-id`
  specifies a new local ID, not resumption. Server-mode
  `claude remote-control --session-id <remote-id>` has a different meaning.
- Restored owner account/organization are compared with the current attributed
  login. Confirmed mismatch vetoes reattach and suppresses history. Unknown,
  unreadable or unconfirmed ownership pins reattach-or-fail. Matching ownership
  normally allows fresh-mint fallback (`tengu_sequential_puffin` feature flag);
  disabling that flag pins it too. Explicit host/environment handoffs retain owner
  protections; unavailable owner confirmation pins reattach-or-fail. The launcher
  does not override these internal mechanisms.
- Reattach unarchives the recorded ID and obtains fresh bridge credentials.
  Success or unarchive 409 preserves identity. Invalid IDs, remembered final
  refusals, or unarchive 400/403/404 can classify it gone and permit minting only
  in the fallback lane; pinned mode fails. Elevated-auth or transient failures
  do not establish expiry and do not by themselves mint a replacement. The logged
  credential expires_in=46800s is not the registration lifetime; no fixed remote
  registration expiry TTL was established from the inspected artifacts.
- `--remote-control <name>` enables the bridge and sets its initial title. It
  neither selects a remote ID nor forces creation. On reattach the core retains
  the existing session; its initial title is used for creation, not an unconditional
  rename of the existing server entry. Use `/rename` or app Rename for an existing
  title. An unnamed fresh bridge derives a title from meaningful message history,
  explaining the last-message title at 01:33.

## Change and real-run evidence

Conversation keeps explicit resume ID `5467c555-7279-5b55-b8ce-e262b1e2e1f7`
and requested remote-control name Surface-collaboration. Haiku now resumes its
existing ID `00e7448d-db05-4a56-a669-0fc8254d1f56` with its existing name,
model, effort and permissions. Scheduled tasks and duplicate detection are unchanged.

Two PID-limited stops of idle Haiku and launches through Start-ClaudeSession.ps1:

| Run | PID | Reattach time (UTC, November 22) | Worker epoch |
| --- | --- | --- | --- |
| Existing boot launch | 11008 | Created 16:38:21.080Z | 1 |
| First restart | 12216 | 17:32:57.742Z | 2 |
| Second restart | 19412 | 17:34:46.713Z | 3 |

Both restart logs contain this exact message followed by successful connected transport:

```text
[bridge:repl] Reattaching to persisted bridge session cse_01BssPsYHzaVEHTXEyc3SJsj at seq 0 (fresh-mint fallback, restored_owner_match)
```

Both new PID records retained `bridgeSessionId: session_01BssPsYHzaVEHTXEyc3SJsj`.
Exactly one Haiku remained (19412). Interactive conversation PID 18208 and process
start time were unchanged; autopilot was untouched. No prompts were submitted.
Existing Session.test.ps1 (8) and MobileConnection.test.ps1 (7) passed. Raw logs,
source excerpts and result.json are in ignored `state/claude-startup/reattach-20261123/`.
This verified process restarts, not a Windows reboot or phone message round trip.

## Next reboot and stale entries

After the next separately authorized real reboot, expect conversation-debug.log:

```text
[bridge:repl] Reattaching to persisted bridge session cse_01BssPsY9uf6wywfFrPBF8eV at seq <saved-sequence> (fresh-mint fallback, restored_owner_match)
```

Expect the analogous Haiku line above in haiku-debug.log (sequence may advance),
followed by connected transport and unchanged session_ suffixes in new PID files.
Check the retained current entries on the phone. This does not merge the old
standalone entry into the interactive registration. Actual server deletion/refusal
or account change can prevent retention; an explicit name cannot prevent that.

The app/claude.ai UI supports archive/delete of stale entries. Bundled code also
contains authenticated internal POST archive endpoints:
`/v1/sessions/<session-id>/archive` and, under the CRUD flag,
`/v1/code/sessions/<cse-id>/archive`. Removal is technically not UI-only, but these
are private implementation APIs, not a documented public Remote Control cleanup
CLI/API. `claude rm` manages background sessions, not arbitrary stale phone entries.
Use the app UI for supported cleanup. No archive/delete operation was performed.

References: [official Remote Control docs](https://code.claude.com/docs/en/remote-control)
and [CLI reference](https://code.claude.com/docs/en/cli-reference). Local source
conditions above were checked in the installed executable, not inferred from
server-mode resume examples.
