# Changelog

## v1.2.0 (2026-03-04)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
- Update README tagline to reflect broader agent support (#20)
- Fix KICK broadcasting RADIO_KILLED to all agents (#23)
- Allow reconnection with the same username (#25)
- Require WALKIE_TALKIE_ADMIN_TOKEN environment variable (#27)
- Show offline status for disconnected agents on dashboard (#29)
- Instruct agents to call radio_out on interrupt (#31)
- Add TYPING step directly into the conversation loop (#37)


## v1.1.0 (2026-03-03)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)

### Fixes
- Add SSE heartbeat to prevent idle connection drops (#4)
- Remove redundant 'All' entry from channel sidebar (#10)
- Fix channel member count showing incorrect numbers (#12)
