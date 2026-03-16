# Jules REST API Sources

Sources represent repositories connected to Jules. Currently, Jules supports GitHub repositories. Use the Sources API to list available repositories and get details about specific sources.

Sources are created when you connect a GitHub repository to Jules through the web interface. The API currently only supports reading sources, not creating them.

## List Sources

`GET /v1alpha/sources`

Lists all sources (repositories) connected to your account.

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `pageSize` | integer | Number of sources to return (1-100). Defaults to 30. |
| `pageToken` | string | Page token from a previous ListSources response. |
| `filter` | string | Filter expression based on AIP-160. Example: `'name=sources/source1 OR name=sources/source2'` |

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?pageSize=10"
```

### Response

```json
{
  "sources": [
    {
      "name": "sources/github-myorg-myrepo",
      "id": "github-myorg-myrepo",
      "githubRepo": {
        "owner": "myorg",
        "repo": "myrepo",
        "isPrivate": false,
        "defaultBranch": {
          "displayName": "main"
        },
        "branches": [
          { "displayName": "main" },
          { "displayName": "develop" },
          { "displayName": "feature/auth" }
        ]
      }
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

## Get a Source

`GET /v1alpha/sources/{sourceId}`

Retrieves a single source by ID.

### Path Parameters

- `name`: string (required) - Format: `sources/{source}`

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources/github-myorg-myrepo
```

### Response

Returns the full [Source](types.md#source) object:

```json
{
  "name": "sources/github-myorg-myrepo",
  "id": "github-myorg-myrepo",
  "githubRepo": {
    "owner": "myorg",
    "repo": "myrepo",
    "isPrivate": false,
    "defaultBranch": {
      "displayName": "main"
    },
    "branches": [
      { "displayName": "main" },
      { "displayName": "develop" },
      { "displayName": "feature/auth" },
      { "displayName": "feature/tests" }
    ]
  }
}
```

## Using Sources with Sessions

When creating a session, reference a source using its resource name in the `sourceContext`:

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add unit tests for the auth module",
    "sourceContext": {
      "source": "sources/github-myorg-myrepo",
      "githubRepoContext": {
        "startingBranch": "develop"
      }
    }
  }' \
  https://jules.googleapis.com/v1alpha/sessions
```
