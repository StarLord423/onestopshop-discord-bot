# OneStopShop Community bot

Custom single-server Discord bot. Tracks inferred invite attribution and retained
members, edits one leaderboard, and supports earned-reward notices with manual
staff fulfillment. It never stores or sends reward keys.

Source repository: https://github.com/StarLord423/onestopshop-discord-bot

For owner setup and deployment migration, read [HANDOFF.md](HANDOFF.md). Clone
this repository, run `npm ci`, then `npm run verify` before proposing changes.
GitHub Actions runs the same checks on pushes and pull requests. Public visibility
allows reading/forking; collaborators with write access can push branches and
open pull requests. Source updates do not automatically deploy the running bot.

## Server configuration

- Guild: `1551412456050401300` (OneStopShop).
- Application: `1558554932951650355` (OneStopShop Community).
- Existing leaderboard: `1558519162303811634` (#🫆leaderboards).
- Default invite destination: `1551415168712572928` (#👋welcome).
- Private staff reward channel: `1558558687461642260` (#invite-rewards).
- Role menu: `1551415907207741480` (#🔏get-a-role).
- Private role decision channel: `1558915969466765382` (#role-approval).
- Default account age: 30 days at first tracked join.
- Default continuous observed stay: 7 days.
- Enabled milestones, chosen by the user: 10 qualified invites = 24 free hours of
  Builder Pro; 25 = 1 free week of Builder Pro; 50 = 1 free week of any non-PvP
  catalog script of the member's choice. All PvP scripts, including NH Tier A and
  NH Tier B, are excluded. Each milestone can be earned once per member.
- Claim instructions direct members to #ticket-support with their Reward ID.
  Staff reviews eligibility and delivers the key manually.

## Running locally

Node 22+; this workspace was prepared with Node 24.16.0. Install dependencies with
`npm ci`. Run `Setup.cmd` to save a bot token in a masked local form. Enable Server
Members Intent in the Developer Portal and install the application in OneStopShop.
Never put tokens in Discord messages, chat, screenshots, or source control. If a
token is exposed, reset it and replace it locally.

Run `Start-Bot.cmd`, or `npm start` from this folder. Only one worker may run.
The bot creates a local PostgreSQL database under `data/postgres` using PGlite.
For a hosted PostgreSQL database, set DATABASE_URL in the ignored `.env` file.
The external database adapter is included but has not been integration-tested
against a hosted server in this workspace.

The local worker needs this PC awake and connected. It is not hosted in Discord:
the Discord app is only its interface. No paid hosting or Windows auto-start has
been configured. For continuous service, deploy this directory as an always-on
worker with persistent storage or an external PostgreSQL connection.

Normal shutdown: Ctrl+C for a foreground worker, or `Stop-Bot.cmd` for the local
background worker (allows about 15 seconds to close the database). A hard crash may leave
`data/worker.lock`; verify the PID in it no longer exists before removing only that
file. Do not delete `data/postgres`. For hosted PostgreSQL, a session advisory lock
also prevents multiple workers against the same database.

## Commands

- `/invite`: create/reuse a personal invite; obey community anti-spam rules.
- `/invites`: your rank across all current human members and private
  qualified/pending/review/left/excluded totals, even outside the public top 25.
- `/leaderboard`: private copy of the board; the public board updates automatically.
- `/rewards dm-notifications:true`: explicitly enable reward DMs and view awards.
- `/oss-help`: counting/data-use information and appeals guidance.
- `/oss-setup`: set invite destination, private staff queue, and claim instructions.
- `/oss-status`: health and up to five pending staff awards.
- `/referral`: inspect; assign unresolved ownership; approve account-age review;
  exclude. Mutations require a reason and are audited. Existing ownership cannot
  be transferred. Launch-baseline members cannot be credited.
- `/reward-rule`: list/set/disable milestones; each threshold has a stable identity.
  One award per member per threshold. Changing the description does not issue the
  same milestone again. Existing awards retain their original reward description.
- `/reward-staff action:take id:...`: assign the award to yourself.
- `/reward-staff action:fulfill id:...`: record your manual fulfillment after you
  give the member their key. Only the assigned staff member can complete it.
- `/reward-staff action:cancel id:... reason:...`: cancel with an audit record.

Staff commands default to Manage Server permission and enforce authorization at
runtime. Optional STAFF_ROLE_IDS are recognized at runtime, but Discord command
visibility must also be granted to those roles by a server administrator.

The bot's installation permissions are Manage Server (invite metadata), Create
Invite, View Channels, Send Messages, Embed Links, and Read Message History.
The role-request feature additionally needs Manage Roles and Add Reactions. Move
the bot's highest role above the five requestable roles, while keeping it below
staff and admin roles. Never grant Administrator. No message-content access is
requested. The bot checks its permissions and role hierarchy before posting the
menu; invite tracking continues if role requests are unavailable.
This build uses invite snapshots rather than create/delete events; it therefore
does not require Manage Channels or GuildInvites intent. Read Message History is
used for its own leaderboard/queue message recovery.

## Role requests

The bot maintains one message in #🔏get-a-role with reactions for OSS VIP
Premium, OSS VIP, Lurker ++, Lurker, and Beta Tester. These are exact role IDs in
`src/role-requests.ts`; no other role can be requested. A reaction creates one
pending request per member and role. Staff decide with Approve or Deny buttons
in private #role-approval. The bot checks the requested role again when approving
and records the decision in the database audit log. Removing a reaction does not
revoke a role. After a denial, the member must remove and re-add the reaction to
request again. DMs about requests and decisions are best effort.
The bot binds decisions to its saved staff card, checks staff authorization again
when processing, and verifies a fresh member-role receipt before recording approval.
If Discord cannot confirm an addition, inspect the member's roles before retrying;
an API/network failure may happen after a role was applied.

Beta Tester requests tell staff to check the existing application in
#📜become-a-beta-tester or the support ticket before approval. The bot does not
read applications or verify payment for VIP roles; staff make those decisions.
Only the owner, Manage Server members, and the fixed staff-role allowlist may
use the decision buttons. The role panel is posted only when the bot can manage
all five roles and the approval channel remains private to ordinary members.
Pending requests and the menu message ID survive restarts. The bot retries
pending staff cards when it starts and during its five-minute maintenance pass.

## Counting and recovery

Discord does not provide the used invite in a member-join event. Only a clean
single-member/single-counter increment is inferred. Concurrent/unknown/deleted/
vanity links and gaps stay unresolved. This deliberately favors avoiding false
credit over attributing every join. It does not prove distinct humans.

Launch imports existing members as a baseline without retroactive credit.
Member departures subtract active credit; returning members retain original
ownership and must complete a new stay period. Bot and self referrals are
excluded; young accounts require staff review. Screening must be completed.

Restart/disconnection reconciliation conservatively restarts observed stay for
present referrals, even if Discord can resume some events. This can delay credit;
it avoids claiming uninterrupted membership across an unverified gap. Periodic
membership reconciliation runs every five minutes; leaderboard updates are
coalesced at 15 seconds and refreshed at least every five minutes when healthy.

The public board shows the top 25 current human members, including members with
zero invites. INVITES counts qualified referrals and WAIT counts pending ones.
Ranks use qualified totals only: equal totals share a competition rank (1, 1, 3),
marked T for tied; alphabetical display order does not break a tie. Bots and
members who have left are omitted. `/invites` reports your rank across the full
member list even if you are outside the public top 25. No old invite totals are
invented or imported when adding zero-score members to the display.

The database and outbox survive restarts. Reward records and notification status
are separate. Blocked DMs do not erase earned awards; `/rewards` works privately.
Opting in again retries blocked notices. Sending and recording a DM are not one
atomic network transaction, so a crash can repeat a notification; it does not
create another award. Staff queue creation uses a stable message nonce as an
additional short-window duplicate safeguard.

Loss of eligibility holds an open award. Requalification restores the original
award and staff assignment, not a new reward. Fulfilled/cancelled awards remain
closed. Staff completion is a staff report, not proof of key delivery/redemption.

## Validation and operations

`npm run verify` runs TypeScript checking and real embedded-PostgreSQL tests for
attribution, screening, retention, leave/rejoin, duplicate events, reviews,
milestone uniqueness, staff ownership, holds, recovery and persistence. These
tests do not establish a real Discord invite/member event or successful DM.

Back up after a clean shutdown: the whole `data/postgres` folder and configuration
kept separately in secure storage. Never copy an active database directory as a
verified backup. Hosted deployments should use PostgreSQL's supported backup
tools. Test restoration before calling deployment production-ready. Pause reward
processing after restoring a stale backup until staff reconciles completed awards.

Logs intentionally avoid tokens and message content. Local `.env`, `data`, logs,
and dependencies are gitignored. Do not export member/referral data unnecessarily.
An operator retention/deletion policy and restore drill remain rollout work;
there is not yet a self-service deletion or backup scheduler.

Discord's current policy identifies invite rewards as a form of artificial
membership inflation. Manual fulfillment does not remove that concern. Reward
configuration is separate from tracking. The user subsequently selected and
enabled the three milestones above; this is not Discord policy approval.
See [the research plan](docs/DISCORD-BOT-PLAN.md) for sources and rollout gates.

## Installation receipt — October 10, 2026

Installed in OneStopShop and running as a local background worker. The public
leaderboard is message `1558557255878836228`. Initial reconciliation captured
21 existing members and 17 invite counters as a baseline. Existing InviteLogger
was left unchanged; its historical counts were not imported.

Verified through Discord: the public board, a personal `/invite` response,
`/oss-status`, private queue configuration, and the three enabled reward rules.
TypeScript checking and 12 embedded-PostgreSQL tests passed. No real new-member
join/leave or earned-reward DM has been exercised yet. No keys were issued.

Known operational limits: automatic hold/requalification updates the award ledger,
but an existing staff queue embed refreshes on a staff action, not immediately.
Run `/oss-status` and take the award before manual handoff; the take/fulfill commands
reconcile membership and enforce current eligibility. During an API outage the
public board can retain its last successful timestamp instead of showing a paused
badge. Treat that timestamp as the freshness signal. Persistent hosting, backup
restoration, and a published data-retention policy remain rollout work.
