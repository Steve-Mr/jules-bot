# Jules REST API Activities

Activities represent events that occur during a session. Use the Activities API to monitor progress, retrieve messages, and access artifacts like code changes.

## List Activities

`GET /v1alpha/sessions/{sessionId}/activities`

Lists all activities for a session.

### Path Parameters

- `parent`: string (required) - Format: `sessions/{session}`

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `pageSize` | integer | Number of activities to return (1-100). Defaults to 50. |
| `pageToken` | string | Page token from a previous ListActivities response. |

### Example Requests

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions/1234567/activities?pageSize=20"
```

### Response

```json
{
  "activities": [
    {
      "name": "sessions/1234567/activities/act1",
      "id": "act1",
      "originator": "system",
      "description": "Session started",
      "createTime": "2024-01-15T10:30:00Z"
    },
    {
      "name": "sessions/1234567/activities/act2",
      "id": "act2",
      "originator": "agent",
      "description": "Plan generated",
      "planGenerated": {
        "plan": {
          "id": "plan1",
          "steps": [
            {
              "id": "step1",
              "index": 0,
              "title": "Analyze existing code",
              "description": "Review the authentication module structure"
            },
            {
              "id": "step2",
              "index": 1,
              "title": "Write unit tests",
              "description": "Create comprehensive test coverage"
            }
          ],
          "createTime": "2024-01-15T10:31:00Z"
        }
      },
      "createTime": "2024-01-15T10:31:00Z"
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjIwfQ=="
}
```

## Get an Activity

`GET /v1alpha/sessions/{sessionId}/activities/{activityId}`

Retrieves a single activity by ID.

### Path Parameters

- `name`: string (required) - Format: `sessions/{session}/activities/{activity}`

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions/1234567/activities/act2
```

### Response

Returns the full [Activity](types.md#activity) object:

```json
{
  "name": "sessions/1234567/activities/act2",
  "id": "act2",
  "originator": "agent",
  "description": "Code changes ready",
  "createTime": "2024-01-15T11:00:00Z",
  "artifacts": [
    {
      "changeSet": {
        "source": "sources/github-myorg-myrepo",
        "gitPatch": {
          "baseCommitId": "a1b2c3d4",
          "unidiffPatch": "diff --git a/tests/auth.test.js...",
          "suggestedCommitMessage": "Add unit tests for authentication module"
        }
      }
    }
  ]
}
```

## Activity Types

Activities have different types based on what occurred. Each activity will have exactly one of these event fields populated:

- **Plan Generated**: Indicates Jules has created a plan for the task.
- **Plan Approved**: Indicates a plan was approved.
- **User Messaged**: A message from the user.
- **Agent Messaged**: A message from Jules.
- **Progress Updated**: A status update during execution.
- **Session Completed**: The session finished successfully.
- **Session Failed**: The session encountered an error.

## Artifacts

Activities may include artifacts produced during execution:

- **Code Changes (ChangeSet)**: Unified diff patch and suggested commit message.
- **Bash Output**: Output from a bash command (stdout, stderr, exit code).
- **Media**: Media file produced (e.g. image/png).
```json
{
  "artifacts": [
    {
      "bashOutput": {
        "command": "npm test",
        "output": "All tests passed (42 passing)",
        "exitCode": 0
      }
    }
  ]
}
```
