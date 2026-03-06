# Changelog

## v1.5.0 (2026-03-07)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)
- Replace dropdown selects with @mention and #channel autocomplete (#42)
- Persist channel membership and auto-rejoin on reconnect (#44)
- Persist channel messages in SQLite and restore on dashboard refresh (#46)
- Move member info from sidebar badge to channel header (#50)
- Rename Stop All to Kick all agents and exclude operator (#52)
- Add image sending from Operator dashboard to Agent (#60)
- Support image sending from Agent to Operator via radio_over (#66)
- Add radio_send_image tool for fast file-based image sending (#68)
- Add Slack bot integration (Socket Mode) (#73)

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
- Show typing indicator in message area and fix TYPING response (#39)
- Scope typing indicator to the active channel (#56)
- Fix agent replying in wrong channel (#58)
- Fix image content blocks not reaching Agent via radio_standby (#62)
- Rebuild plugin bundle to include image support in radio_standby (#64)

### Other
- Add /create-pr Claude Code skill (#48)
- Introduce Biome for lint/format and add hub test suite (#54)
- Add Cursor workaround for slash command in README (#71)
- Bump version to v1.4.0 (#74)
- Fix Cursor setup instructions in README (#77)
- Add tests for image sending feature (#79)


## v1.4.0 (2026-03-06)

### Features
- Add Slack bot integration via Socket Mode (#72)
- Add radio_send_image tool for fast file-based image sending (#68)

### Docs
- Add Cursor workaround for slash command in README (#70)

## v1.3.0 (2026-03-05)

### Features
- Add Cursor Agent support (#2)
- Highlight operator messages and add filter toggle (#6)
- Add channel support for scoped conversations (#8)
- Allow admin token to be configured via env var (#14)
- Add comparison with multi-agent frameworks to README (#16)
- Add comparison with agent platforms (OpenClaw) to README (#18)
- Add typing indicator and response detection to dashboard (#35)
- Replace dropdown selects with @mention and #channel autocomplete (#42)
- Persist channel membership and auto-rejoin on reconnect (#44)
- Persist channel messages in SQLite and restore on dashboard refresh (#46)
- Move member info from sidebar badge to channel header (#50)
- Rename Stop All to Kick all agents and exclude operator (#52)
- Add image sending from Operator dashboard to Agent (#60)
- Support image sending from Agent to Operator via radio_over (#66)

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
- Show typing indicator in message area and fix TYPING response (#39)
- Scope typing indicator to the active channel (#56)
- Fix agent replying in wrong channel (#58)
- Fix image content blocks not reaching Agent via radio_standby (#62)
- Rebuild plugin bundle to include image support in radio_standby (#64)

### Other
- Add /create-pr Claude Code skill (#48)
- Introduce Biome for lint/format and add hub test suite (#54)


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
