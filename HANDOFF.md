# OneStopShop Community bot — owner handoff

This package contains source code and setup instructions. It does not transfer
control of the Discord application, include its token, or include member data.
Public source repository: https://github.com/StarLord423/onestopshop-discord-bot
Direct pushes require collaborator access. GitHub access does not grant control
of the Discord application or the machine currently running the bot.

## What is included

TypeScript/discord.js bot, persistent PostgreSQL/PGlite ledger, invite attribution,
live rankings, private personal-rank command, reward notifications, manual staff
fulfillment, masked Windows token setup and 13 database tests. See README.md.

Latest verification on October 10: TypeScript and 13 tests passed; live rankings
and the personal-rank response were inspected. Real invite join/leave events,
earned-reward DMs, hosted PostgreSQL and backup restoration remain unverified.
The README records operational limitations and the researched invite-reward policy
concern. The bot does not prove that Discord accounts represent distinct people.

## Review or run a separate test installation

1. Install Node.js 22 or later (tested with 24.16.0), extract, and run `npm ci`.
2. Run `npm run verify` to check types and execute the database tests.
3. For a separate test application, set its server/channel IDs in a local `.env`
   copied from `.env.example`. Enable Server Members Intent for that application.
4. On Windows run `Setup.cmd` to enter its bot token privately. Never commit `.env`.
5. Run `Start-Bot.cmd` or `npm start`. Use a dedicated test server for fake referrals
   and reward tests; do not add synthetic credits to the live OneStopShop ledger.

## Take over the existing live installation

Coordinate the cutover with the current operator first. Do not run this package
against the live bot token while the old worker is running. Local lock files only
prevent duplicates on the same machine; two separate machines can both connect.

- Existing application:1558554932951650355, server:1551412456050401300.
- Leaderboard channel:1558519162303811634; message:1558557255878836228.
- Welcome/invite channel:1551415168712572928.
- Private reward queue:1558558687461642260.
- Ensure the owner controls the Discord application and hosting separately from
  receiving this source package. Arrange credential rotation privately at cutover.
- Stop the old worker using Stop-Bot.cmd; verify it exited and worker.lock cleared.
- Separately arrange a secure transfer of the stopped `data/postgres` directory.
  It contains personal member records, ownership mappings, reward settings and
  fulfillment history. Keep it out of GitHub and ordinary source-code archives.
- Configure the owner's private `.env`, restore the database under data/postgres,
  and start exactly one worker. Do not copy worker.lock or process-id.txt.
- Verify /oss-status, the existing board message, /invite and /rewards. A restart
  conservatively restarts observed retention. Do not launch a fresh live ledger
  without explicitly deciding how existing referrals and fulfilled awards migrate.

A fresh database does NOT contain the live reward rules or claim instructions.
The existing database has these once-per-member qualified-invite milestones:

| Invites | Reward |
| --- | --- |
| 10 | 24 hours of Builder Pro free |
| 25 | 1 week of Builder Pro free |
| 50 | 1 week of any non-PvP catalog script of the member's choice |

All PvP scripts, including NH Tier A and NH Tier B, are excluded. Staff supplies
keys manually via ticket support. The bot stores no reward keys. Members opt into
DMs with `/rewards dm-notifications:true`; /rewards is the private fallback.

The current installation uses this operator's PC, not an always-on host. Arrange
hosting with persistent storage, a secure backup/restore procedure and the server's
data-retention policy for ongoing operation. No hosting subscription is included.
