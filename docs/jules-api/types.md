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
| `createTime` | string (google-datetime) | Output only. When the session was created. |
| `updateTime` | string (google-datetime) | Output only. When the session was last updated. |

### SessionState (Enum)

| Value | Description |
|---|---|
| `STATE_UNSPECIFIED` | State is unspecified |
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

An activity represents a single unit of work within a session.

| Field | Type | Description |
|---|---|---|
| `name` | string | The full resource name (e.g., 'sessions/{session}/activities/{activity}'). |
| `id` | string | Output only. The activity ID. |
| `originator` | string | The entity that created this activity ('user', 'agent', or 'system'). |
| `description` | string | Output only. A description of this activity. |
| `createTime` | string (google-datetime) | Output only. When the activity was created. |
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

An input source of data for a session.

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
| `createTime` | string (google-datetime) | Output only. When the plan was created. |

### PlanStep

| Field | Type | Description |
|---|---|---|
| `id` | string | Output only. Unique ID for this step within a plan. |
| `index` | integer (int32) | Output only. 0-based index in the plan. |
| `title` | string | Output only. The title of the step. |
| `description` | string | Output only. Detailed description of the step. |

---

## Artifacts

### Artifact

A single unit of data produced by an activity.

| Field | Type | Description |
|---|---|---|
| `changeSet` | [ChangeSet](#changeset) | Code changes produced. |
| `bashOutput` | [BashOutput](#bashoutput) | Command output produced. |
| `media` | Media | Media file produced (e.g., image, video). |

### ChangeSet

- `source`: string. The source this change set applies to. Format: `sources/{source}`
- `gitPatch`: [GitPatch](#gitpatch). The patch in Git format.

### GitPatch

- `baseCommitId`: string. The commit ID the patch should be applied to.
- `unidiffPatch`: string. The patch in unified diff format.
- `suggestedCommitMessage`: string. A suggested commit message for the patch.

### BashOutput

- `command`: string. The bash command that was executed.
- `output`: string. Combined stdout and stderr output.
- `exitCode`: integer (int32). The exit code of the command.

---

## GitHub Types

### GitHubRepo

- `owner`: string
- `repo`: string
- `isPrivate`: boolean
- `defaultBranch`: [GitHubBranch](#githubbranch)
- `branches`: [GitHubBranch](#githubbranch) []

### GitHubBranch

- `displayName`: string

### GitHubRepoContext

- `startingBranch`: required string. The branch to start the session from.

---

## Context Types

### SourceContext

- `source`: required string. The source resource name. Format: `sources/{source}`
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

### PlanGenerated
- `plan`: [Plan](#plan)

### PlanApproved
- `planId`: string

### UserMessaged
- `userMessage`: string

### AgentMessaged
- `agentMessage`: string

### ProgressUpdated
- `title`: string
- `description`: string

---

## Request/Response Types

### SendMessageRequest
- `prompt`: required string. The message to send.

### SendMessageResponse
- Empty response on success.

### ApprovePlanRequest
- Empty request body.

### ApprovePlanResponse
- Empty response on success.

### ListSessionsResponse
- `sessions`: [Session](#session) []
- `nextPageToken`: string

### ListActivitiesResponse
- `activities`: [Activity](#activity) []
- `nextPageToken`: string

### ListSourcesResponse
- `sources`: [Source](#source) []
- `nextPageToken`: string
