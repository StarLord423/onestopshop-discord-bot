# OneStopShop Discord bot: research and staged implementation

Prepared October 10, 2026. Updated after implementation on the same date.

## Current implementation

The custom bot is now implemented in `discord-bot/`, installed in OneStopShop
(`1551412456050401300`), and running locally. Application ID:
`1558554932951650355`. Public leaderboard channel: `1558519162303811634`.
Private manual-reward queue: `1558558687461642260`. Keys remain manual.

The user selected these enabled once-per-member qualified-invite milestones:

| Qualified invites | Reward |
| --- | --- |
| 10 | 24 hours of Builder Pro free |
| 25 | 1 week of Builder Pro free |
| 50 | 1 week of any non-PvP catalog script of the member's choice |

All PvP scripts, explicitly including NH Tier A and NH Tier B, are excluded.
Claims go through #ticket-support with the Reward ID. Automated DMs require
member opt-in via `/rewards dm-notifications:true`; `/rewards` is the private fallback.

Implemented defaults are 30-day account age and seven days of observed continuous
membership. Attribution is conservative and unresolved cases require review.
Existing members were baselined without retrospective credit. Runtime uses
TypeScript/discord.js and persistent embedded PostgreSQL (PGlite); external
PostgreSQL is supported but not integration-tested. Invite snapshots mean this
build does not need Manage Channels or invite-event intent.

Verified: TypeScript check, 12 database tests, live board, personal invite command,
tracking status, private channel configuration, and enabled reward-rule responses.
Real join/leave and reward DM acceptance testing, persistent hosting, and backup
restoration remain pending. See `discord-bot/README.md` for commands and limitations.
The research and staged rollout below are retained as design context, not a claim
that all production acceptance gates have passed.

User clarification: keys will be supplied manually by staff. The bot only detects
earned rewards, sends the member an automated notification, and tracks staff
fulfillment. No key inventory, key storage, licensing API, or automated key delivery.

## Recommendation

Build a small custom TypeScript/discord.js bot with PostgreSQL and one always-on
worker. Start with personal invite links, a durable member/referral ledger, and
one automatically updated message in #leaderboard. Keep attribution confidence,
membership retention, reward notifications, and manual fulfillment as separate concerns.

Do not promise a scam-proof system. Discord accounts are not verified unique
people; old alternate accounts and colluding real accounts can pass simple checks.

There is also a concrete policy issue with the requested later feature. Discord's
current Platform Manipulation Policy Explainer explicitly includes invite rewards
among examples of artificial membership inflation. A free software key for a
join quota falls within that concern. My recommendation is to launch tracking
without material invite rewards, and redesign the reward trigger around genuine
reviewed contributions, such as useful bug reports. That alternative still needs
its final rules checked; it is not a claim of Discord approval. Requiring members
to stay or complete verification does not itself resolve the invite-reward issue.
[Source: Discord platform manipulation policy](https://discord.com/safety/platform-manipulation-policy-explainer)

The reward-notification module below remains useful whichever acceptable trigger
is chosen. Manual key fulfillment does not remove the policy concern about the
invite-based incentive. No policy clarification has been requested from Discord.

## Verified platform facts and their implications

| Finding | Design consequence |
| --- | --- |
| Member-add events contain a member and guild ID, with no documented used-invite field. They can also arrive for existing members. | Native invite attribution is inferred; deduplicate events. |
| Invite metadata contains usage totals. | Compare persisted snapshots; totals alone do not identify individual joiners. |
| Guild-wide invite metadata requires Manage Server / MANAGE_GUILD. | View Audit Log alone is insufficient for this counter-based design. |
| Invite create/delete events require Manage Channels in the relevant channel. | Scope that permission to the invite channel and also reconcile snapshots. |
| Members can be pending rules screening. | Joining is not the same as completing onboarding. |
| Users may not accept bot DMs. | Notifications need a private reward-status fallback and a recorded failure state. |

Sources: [Gateway events](https://docs.discord.com/developers/events/gateway-events),
[invite metadata](https://docs.discord.com/developers/resources/invite),
[guild invites and screening](https://docs.discord.com/developers/resources/guild),
[DM error 50007](https://docs.discord.com/developers/topics/opcodes-and-status-codes).

Ordinary bot membership data does not expose IP addresses, hardware identity, or
a reliable same-human/alternate-account verdict. Do not advertise those checks.
The bot also cannot infer phone/email verification from arbitrary member records.
Account creation time and a bot flag are useful signals, not proof of identity.
[User fields](https://docs.discord.com/developers/resources/user)

## Tracking method

### Personal links and attribution

1. A member runs /invite. Return their existing managed link, or create one and
   persist invite-code -> owner-user-ID -> guild-ID. Use Discord IDs as strings.
   When the bot creates the invite, Discord's inviter may be the bot itself;
   therefore our owner mapping, not that field, decides whose link it is.
2. Request a unique, non-temporary invite with no expiration and unlimited uses.
   Reuse one active link per participant. Handle creation quotas/errors without
   generating endless replacement links. Keep old mappings when links are revoked.
3. Snapshot all visible guild invites and vanity usage where supported. Import
   existing links only with an attributable owner; old usage totals are baseline
   information, never newly earned credits.
4. Buffer joins briefly and process snapshot comparisons through one serialized
   queue per guild. Persist joins, counter observations, and decisions transactionally.
5. Attribute only clean comparisons, for example one new join and one matching
   +1 change with continuous observation. Label this inferred, not proven.
   Multiple links changing together, missing counters, deleted links, unexplained
   increments, or observation gaps produce unresolved records. Never arbitrarily
   pair arrivals with links in arrival order.
6. Consume each observed counter delta at most once. Unknown joins cannot be
   silently carried forward and assigned to an unrelated later increment.
7. Vanity, discovery, untracked joins, and ambiguous batches get no automatic
   individual credit. Staff can correct records with a reason and evidence, while
   preserving the original observation and actor/time audit trail.

The invite creation parameters are documented by Discord; the conservative
comparison algorithm is our proposed implementation, not an API guarantee.
[Create channel invite](https://docs.discord.com/developers/resources/channel#create-channel-invite)

### Stronger attribution option

If counter ambiguity becomes common, add a small referral landing page. A new
member explicitly confirms the referrer and signs in with Discord before joining.
The server binds the referral to the authenticated Discord user ID, then the bot
checks that same ID joins. Use the authorization-code flow with identify only,
one-time state, expiring sessions, and a fixed callback. Do not request email or
automatically add users. Referrer ownership becomes immutable after acceptance.

This establishes a recorded referral choice, not proof of which native invite was
used or which human controls the account. It adds a website/domain and onboarding
friction, so it is outside the first version. It does not solve the policy issue
with paying for Discord joins.
[Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)

## Proposed counting rules

Defaults below are design proposals, not Discord requirements or accepted user
settings. Publish final rules before tracking starts.

| Situation | Proposed behavior |
| --- | --- |
| New attributable member | Pending initially. |
| Account younger than 30 days at first tracked join | Review; never label it a proven fake. |
| Bot account or same inviter/invitee ID | Exclude. |
| Rules screening incomplete | Remain pending. |
| Account meets checks and stays 7 continuous days | Count as qualified retained referral. |
| Member leaves, is kicked, or is banned | Immediately remove active qualified credit. |
| Previously recorded member rejoins | No new referral; keep original owner and restart the stay period. May restore at most the original single credit. |
| Another inviter invites that returning member | No transfer or second credit. |
| Existing members at launch | Baseline only; no retroactive referral credit. |
| Unclear attribution or suspicious join burst | Review/unresolved, excluded from qualified totals. |
| Inviter leaves | Keep history but remove from active ranking; future rewards, if introduced, require current eligibility. |

Seven days measures retention, not activity or genuine interest. Avoid rewarding
message counts, compulsory chatter, or repetitive interactions. Staff review can
flag suspicious patterns, but flags are not automatic bans. Provide an appeal path.

Known historical members must remain recognizable within the published retention
policy. Members who left before installation and for whom no trusted history
exists cannot reliably be identified as returning members. State this limitation.

Keep the following dimensions separate in storage:

- Attribution: inferred / explicitly confirmed / staff corrected / unresolved.
- Membership: present / absent; membership episodes and observation gaps.
- Qualification: pending / qualified / review / excluded, with reason and rule version.
- Reward: earned / awaiting staff / in progress / on hold / fulfilled / cancelled.
- Notification: pending / sent / failed; separate from manual fulfillment.

## Leaderboard and commands

One read-only #leaderboard channel, with a bot-owned top-10 or top-20 embed.
Rank by current qualified retained referrals. Show pending alongside qualified,
and explain that attribution is best effort. Detailed exclusions and review notes
remain private. Ties use a published stable tie-breaker.

Target updates within 15-30 seconds after relevant events under normal conditions;
this is a service target, not guaranteed latency. Update on qualification timers
even when no joins occur. Edit the same stored message, coalesce rapid changes,
and recreate it once if deleted. Display last successful refresh and degraded
tracking status. An offline bot cannot update the message until it reconnects.
Honor Discord rate-limit responses and retry delays rather than hard-coding a
universal request rate. [Rate limits](https://docs.discord.com/developers/topics/rate-limits)

Proposed commands:

- /invite: obtain your managed link and counting rules.
- /invites: private breakdown of qualified, pending, left, and review statuses.
- /leaderboard: view rankings without needing a new public post.
- /privacy and /help: data use, rules, support, and appeal route.
- Staff-only /referral inspect, /referral correct, /referral exclude, /tracking status.
- Later /rewards: private earned-reward status and manual claim instructions,
  with explicit reward-notification opt-in.
- Later staff-only /reward take, /reward fulfill, /reward hold, /reward cancel.

Staff authorization must be checked server-side on every command/button. Escape
user-supplied display names and disable unintended mentions. Log corrections;
do not offer an unexplained edit-total command.

## Architecture and data

Use TypeScript + discord.js, PostgreSQL, and one continuously running worker with
a durable scheduled-job/outbox table. PostgreSQL transactions and unique
constraints protect ownership, credits, milestone awards, and staff assignments.
No Redis, separate admin website, or multiple active bot replicas needed initially.

Pin a supported stable discord.js release and compatible Node runtime in the
lockfile/container during implementation. The official stable documentation
served 14.27.0 with a Node >=24.17.0 requirement during this research; recheck the
published package engines and runtime availability when building rather than
treating a moving documentation URL as a permanent pin.
[discord.js documentation](https://discord.js.org/docs/packages/discord.js/stable)

Suggested tables:

| Table | Purpose |
| --- | --- |
| guild_settings | Channels, role IDs, rules/version, leaderboard message ID. |
| invite_links and invite_snapshots | Link ownership, usage observations, deletions. |
| members and membership_episodes | Baseline, first seen, current presence, joins/leaves. |
| referrals | One record per guild/invitee; owner, evidence, confidence, eligibility. |
| audit_events | Append-only decisions, staff reasons, observation gaps. |
| scheduled_jobs and outbox | Restart-safe qualification, board refresh, notifications. |
| reward_rules and reward_claims | Versioned trigger, reward description, once-only milestone, notification status, assigned staff member, manual fulfillment status/time. |

Raw invite uses never directly equal the leaderboard total. Calculate standings
from eligible referral records; retain old rule versions and avoid silent
retroactive changes. Store timestamps in UTC and render understandable dates.

Limit retained data to this function. Keep secrets in deployment secret storage,
encrypt backups, restrict database access, and redact tokens from logs. Do not
accept or store reward keys in bot commands or records. Publish a privacy/retention
policy and deletion process. Deleting identifying
history can weaken duplicate prevention; do not promise permanent prevention and
complete history erasure simultaneously. No scraping or cross-server profiling.

## Discord setup

- User-owned Developer Portal application, bot token stored as a secret, application ID.
- Server install with bot and applications.commands scopes.
- Guilds and GuildMembers intents; enable privileged Server Members Intent in the portal.
- GuildInvites intent for invite create/delete events.
- Manage Server for invite usage metadata; Create Invite and scoped Manage Channels
  in the invite destination channel.
- View Channel, Send Messages, Embed Links, Read Message History in bot channels.
- An administrator can pin the leaderboard once; no blanket Administrator permission.
- No Message Content or Presence intent for this design. Add moderation-event
  permissions only if separately implementing ban-specific explanations.
- Server ID, invite destination, leaderboard channel, staff log channel, staff role IDs.

Sources: [Gateway intents](https://docs.discord.com/developers/events/gateway),
[guild invites](https://docs.discord.com/developers/resources/guild#get-guild-invites),
[invite events](https://docs.discord.com/developers/events/gateway-events#invite-create),
[install scopes](https://docs.discord.com/developers/topics/oauth2).

## Later reward notifications and manual fulfillment

Decide an acceptable trigger before enabling material rewards. The original
invite milestone trigger is recorded as the user's request but is not recommended
for launch under the policy cited above. For an approved contribution program,
staff can authorize a specific award and the bot can notify the recipient and
track the manual handoff. For a configured milestone, notification is automatic
once its eligibility rules pass; a staff approval step is not added by default.

If a milestone model is retained after that decision, define exact semantics:
one award per guild/user/program/milestone, no reset after leaving/rejoining or
falling below a threshold. Distinguish cumulative milestones (e.g. 10, 25, 50)
from spending credits on repeat rewards. Do not implement both accidentally.
The threshold X and repeat/cap rules remain undecided.

Notification and fulfillment sequence:

1. Recheck eligibility, then atomically create one earned-reward record and its
   notification jobs. Persist the reward description, milestone, rule version,
   qualifying evidence, and unique claim ID.
2. Send an automated DM naming the earned reward and explaining the manual claim
   process, with the recipient's opt-in. Save notification status independently
   from award status. Discord requires permission to contact users.
   [Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)
3. Add a staff-channel queue entry showing the member, milestone, reward, claim
   ID, and Awaiting staff status. The bot does not include or request a key.
4. If DMs are blocked, the reward remains earned and visible privately through
   /rewards, with claim instructions. Staff sees the failed notification status.
5. A staff member atomically takes ownership of the queue item, manually provides
   the key through the agreed support process, then marks the award fulfilled.
   Record actor and time. This is staff-reported fulfillment, not bot-verified
   delivery or redemption. Other staff cannot take an already assigned item;
   reassignment requires an audited action.
6. Retries, restarts, repeated commands, or crossing the same threshold again
   reuse the existing award. A network timeout can still cause a repeated DM;
   it must not create a second reward or staff task.

Recheck membership and rules before staff fulfillment. If eligibility changes,
flag the existing award On hold for staff resolution under the published rules;
do not silently erase an earned award or create another upon requalification.
Fulfilled records stay fulfilled when counts later drop. Staff handles key supply
outside the bot, so an earned notification must not claim a key was delivered.

Requested invite-based wording, preserved as a conditional draft:

> Congratulations! You've earned a free 1-week OneStopShop key for reaching your
> invite goal! A staff member will provide your key manually. Use /rewards to see
> your reward status and claim instructions. Keep going for more rewards!

Recommended wording for a separately approved contribution award:

> Congratulations! You've been awarded a free 1-week OneStopShop key for your
> contribution! A staff member will provide your key manually. Use /rewards to see
> your reward status and claim instructions.

Reward descriptions and member-facing instructions are configurable. Key sourcing,
redemption, expiration, and revocation remain staff responsibilities. No licensing
integration or key-provider API research is required for this bot's scope.

## Recovery and operations

Use one active worker per guild. On reconnect, attempt supported Gateway resume;
when event continuity cannot be established, mark an observation gap. Reconcile
current membership, recorded joined_at values, invite snapshots, and scheduled
jobs. Do not reconstruct individual attribution from aggregate downtime deltas.
Unknown continuity cannot prove a continuous seven-day stay; hold affected records
or conservatively restart their observed qualification period.

Reconcile periodically and before any future fulfillment. An unavailable guild
or failed member-list request is not evidence that everyone left. Pause affected
qualification on missing permissions or unreliable state. Resume from persisted
data and record the recovery decision.

Host as an always-on worker with PostgreSQL and backups. Railway is a candidate;
its Hobby plan currently has a $5 monthly minimum including $5 resource usage,
with extra usage billed. This is not a quote for bot + database + backups.
Set a planning allowance of $10-25/month, measure actual usage, and choose a plan
suitable for the owner's use. Domain and key costs are separate.
[Railway pricing](https://docs.railway.com/pricing/plans)

Monitor connection health, oldest unresolved join, reconciliation freshness,
leaderboard lag, queue failures, unfulfilled rewards, and notification failures. Test database
restore, protect backups, and retain audit history across redeploys. During a
rollback or stale-backup restoration, pause new reward notifications and staff
handoffs until award records are reconciled with the staff fulfillment history.

## Implementation stages and acceptance criteria

| Stage | Work | Done when |
| --- | --- | --- |
| 1. Lock scope and rules | Decide leaderboard metric, launch baseline, review/retention rules; redesign invite reward trigger; collect server setup data. | Written rules and unresolved decisions are explicit; tracking can proceed independently. |
| 2. Foundation in a test server | Create bot app/config, worker, DB migrations, role checks, secrets, health checks. | Bot connects, persists across restart, and unauthorized staff commands fail. |
| 3. Invite ledger | /invite, owner mapping, snapshots, join/leave episodes, duplicate protection, unresolved queue. | Controlled single joins attribute; ambiguous batches stay unresolved; rejoin cannot create a second credit. |
| 4. Live leaderboard | Qualification timer, private /invites, public embed, recovery and reconciliation. | Counts match test ledger, leaves subtract once, message survives restart/deletion, age-out happens without new events. |
| 5. Production tracking pilot | Deploy with rewards disabled; publish rules; observe real joins and support workload. | At least one full proposed 7-day qualification window and deliberate recovery checks completed; unknown-rate and board lag measured. |
| 6. Reward notifications | Configurable reward rules, once-only award records, opt-in DMs, /rewards fallback, staff queue and manual fulfillment controls; resolve trigger policy before launch. | Test milestone creates one award and staff task; blocked DMs preserve it; staff assignment prevents simultaneous handoffs; manual completion is audited. |
| 7. Operate and refine | Backups, alerts, appeals, documented updates; optional identity-bound referral page. | Restore drill passes, owners can operate it, and no unexplained awards/count changes remain. |

Planning estimate: roughly 4-7 focused developer-days for stages 1-4, followed by
at least a 7-day pilot; roughly 1-2 additional developer-days for reward
notifications and staff fulfillment tracking. The optional referral website
needs a separate estimate. These are estimates, not delivery commitments.

Required tests: duplicate member events; concurrent same/different links;
unknown/vanity joins; revoked or exhausted links; preexisting members; early
leave; rejoin through another owner; incomplete screening; young account review;
expiry without new events; bot restart; missed Gateway interval; lost permissions;
Discord 429/5xx; deleted leaderboard; unauthorized corrections; DB restore.
For rewards add simultaneous threshold checks, blocked DMs, crash before/after
sending, repeated status requests, simultaneous staff assignment, unauthorized
completion, eligibility loss while queued, requalification, notification success
with still-pending fulfillment, and backup rollback after staff completion.

## Inputs still needed

Public documentation cannot establish these owner-specific details:

| Input | Needed by |
| --- | --- |
| Server ID, approximate members/joins per day, existing tracker/export | Stages 1-2: sizing, migration, baseline. |
| Owner's application and deployment access; hosting budget | Stage 2. Never paste secrets in chat. |
| Invite/leaderboard/staff-log channel IDs and allowed staff roles | Stages 2-4. |
| Existing verification/onboarding roles and vanity/discovery use | Stages 1-3. |
| Final 7-day/30-day defaults, rejoin rules, appeals, retention policy | Stages 1-4. |
| Reward trigger redesign or direct policy clarification | Before material invite-based rewards are launched. |
| X/milestones, limits, repeat awards, budget, staff eligibility | Before any milestone implementation. |
| Reward descriptions, member claim instructions, staff queue channel/roles, hold/cancellation rules | Stage 6. Keys are supplied manually outside the bot. |

First buildable slice: one member requests a personal link, one controlled new
member joins, the referral is persisted, and the same leaderboard message updates.
Then prove leave/rejoin and restart behavior before adding broader rules.
