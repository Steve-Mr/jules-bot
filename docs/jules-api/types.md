# Jules REST API Types Reference

This page documents all data types used in the Jules REST API.

## Core Resources

### Session

A session represents a unit of work where Jules executes a coding task.

| Field | Type | Description |
|---|---|---|
| `name` | string | Output only. The full resource name (e.g., 'sessions/{session}'). |
| `id` | string | Output only. The session ID. |
| `prompt` | required string | The task description for Jules to execute. |
| `title` | string | Optional title. If not provided, the system generates one. |
| `state` | [SessionState](#sessionstate) | Output only. Current state of the session. |
| `url` | string | Output only. URL to view the session in the Jules web app. |
| `sourceContext` | required [SourceContext](#sourcecontext) | The source repository and branch context. |
| `requirePlanApproval` | boolean | Input only. If true, plans require explicit approval. |
| `automationMode` | [AutomationMode](#automationmode) | Input only. Automation mode for the session. |
| `outputs` | [SessionOutput](#sessionoutput) [] | Output only. Results of the session (e.g., pull requests). |
| `createTime` | string (datetime) | Output only. When the session was created. |
| `updateTime` | string (datetime) | Output only. When the session was last updated. |

### SessionState (Enum)

| Value | Description |
|---|---|
| `QUEUED` | Session is waiting to be processed |
| `PLANNING` | Jules is creating a plan |
| `AWAITING_PLAN_APPROVAL` | Plan is ready for user approval |
| `AWAITING_USER_FEEDBACK` | Jules needs user input |
| `IN_PROGRESS` | Jules is actively working |
| `PAUSED` | Session is paused |
| `FAILED` | Session failed |
| `COMPLETED` | Session completed successfully |

### AutomationMode (Enum)

| Value | Description |
|---|---|
| `AUTOMATION_MODE_UNSPECIFIED` | No automation (default) |
| `AUTO_CREATE_PR` | Automatically create a pull request when code changes are ready |

---

### Activity

An activity represents a single event within a session.

| Field | Type | Description |
|---|---|---|
| `name` | string | resource name (e.g., 'sessions/{session}/activities/{activity}'). |
| `id` | string | Output only. The activity ID. |
| `originator` | string | entity that created activity ('user', 'agent', or 'system'). |
| `description` | string | Output only. A description of this activity. |
| `createTime` | string (datetime) | Output only. When the activity was created. |
| `artifacts` | [Artifact](#artifact) [] | Output only. Artifacts produced by this activity. |
| `planGenerated` | [PlanGenerated](#plangenerated) | A plan was generated. |
| `planApproved` | [PlanApproved](#planapproved) | A plan was approved. |
| `userMessaged` | [UserMessaged](#usermessaged) | The user posted a message. |
| `agentMessaged` | [AgentMessaged](#agentmessaged) | Jules posted a message. |
| `progressUpdated` | [ProgressUpdated](#progressupdated) | A progress update occurred. |
| `sessionCompleted` | SessionCompleted | The session completed. |
| `sessionFailed` | SessionFailed | The session failed. |

---

### Source

A source represents a connected repository.

| Field | Type | Description |
|---|---|---|
| `name` | string | The full resource name (e.g., 'sources/{source}'). |
| `id` | string | Output only. The source ID. |
| `githubRepo` | [GitHubRepo](#githubrepo) | GitHub repository details. |

---

## Plans

### Plan

A sequence of steps that Jules will take to complete the task.

| Field | Type | Description |
|---|---|---|
| `id` | string | Output only. Unique ID for this plan within a session. |
| `steps` | [PlanStep](#planstep) [] | Output only. The steps in the plan. |
| `createTime` | string (datetime) | Output only. When the plan was created. |

### PlanStep

| Field | Type | Description |
|---|---|---|
| `id` | string | Output only. Unique ID for this step within a plan. |
| `index` | integer | Output only. 0-based index in the plan. |
| `title` | string | Output only. The title of the step. |
| `description` | string | Output only. Detailed description of the step. |

---

## Artifacts

### Artifact

A single unit of data produced by an activity.

- `changeSet`: [ChangeSet](#changeset)
- `bashOutput`: [BashOutput](#bashoutput)
- `media`: Media (MIME type + base64 data)

### ChangeSet

- `source`: string (resource name)
- `gitPatch`: [GitPatch](#gitpatch)

### GitPatch

- `baseCommitId`: string
- `unidiffPatch`: string
- `suggestedCommitMessage`: string

### BashOutput

- `command`: string
- `output`: string
- `exitCode`: integer

---

## GitHub Types

### GitHubRepo

- `owner`: string
- `repo`: string
- `isPrivate`: boolean
- `defaultBranch`: GitHubBranch
- `branches`: GitHubBranch []

### GitHubBranch

- `displayName`: string

### GitHubRepoContext

- `startingBranch`: required string (The branch to start the session from)

---

## Context Types

### SourceContext

- `source`: required string (The source resource name)
- `githubRepoContext`: [GitHubRepoContext](#githubrepocontext)

---

## Output Types

### SessionOutput

- `pullRequest`: [PullRequest](#pullrequest)

### PullRequest

- `url`: string
- `title`: string
- `description`: string

---

## Activity Event Types

- **PlanGenerated**: contains a `plan` object.
- **PlanApproved**: contains a `planId`.
- **UserMessaged**: contains `userMessage` string.
- **AgentMessaged**: contains `agentMessage` string.
- **ProgressUpdated**: contains `title` and `description`.
- **SessionCompleted**: (Empty)
- **SessionFailed**: contains `reason` string.

---

## Request/Response Types

- **SendMessageRequest**: `prompt` (required string)
- **ApprovePlanRequest**: (Empty)
- **ListSessionsResponse**: `sessions` (Session []), `nextPageToken` (string)
- **ListActivitiesResponse**: `activities` (Activity []), `nextPageToken` (string)
- **ListSourcesResponse**: `sources` (Source []), `nextPageToken` (string)
