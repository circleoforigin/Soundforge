# SACscape Development Instructions

## Sensitive files

- Never read, inspect, modify, print, summarize, or otherwise access '.env.local'.
- Never request or expose credentials, access tokens, client secrets, API keys, or other secrets.
- '.env.local' is managed manually by the developer and is outside the scope of Codex tasks.
- When environment configuration is needed, use '.env.example' or describe the required variable names without accessing their values.

## Git workflow

- Before committing, review the current diff and ensure only changes related to the current task are included.
- When asked to commit, create a concise descriptive commit message based on the completed work.
- Push commits to the current branch after committing unless instructed otherwise.
- Never commit `.env.local` or other credential files.