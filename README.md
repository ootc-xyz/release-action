# upload-to-release-server

GitHub Action for publishing a binary to a release server using the documented presigned upload flow:

1. create an upload session on the release server
2. upload the file directly to object storage
3. optionally update an alias such as `latest`
4. optionally verify the release metadata and download URL

This is a JavaScript action, so the action runtime does not depend on `bash`, `curl`, or `jq`, and it is intended to behave the same on GitHub-hosted Linux, macOS, and Windows runners.

Verification follows the release-server guideline: it checks the release metadata API and then confirms that the public download URL responds as a release-server redirect. It does not use `HEAD` against the public download URL.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `release-server-url` | yes |  | Base URL for the release server |
| `api-key` | yes |  | Master API key for the release server |
| `target-name` | yes |  | Target software name in `scope/project` form |
| `release-id` | yes |  | Release identifier to publish under |
| `file-path` | yes |  | Path to the local file to upload |
| `file-name` | no | basename of `file-path` | Published filename; must be a basename, not a path |
| `content-type` | no | `application/octet-stream` | Content type passed to the presign endpoint |
| `alias` | no | empty | Alias to move to this release, such as `latest` |
| `verify` | no | `true` | Verify the release metadata and public download URL after upload |

## Outputs

| Name | Description |
| --- | --- |
| `download-url` | Public release download URL for the uploaded file |
| `release-download-url` | Same as `download-url` |
| `alias-download-url` | Public alias download URL when `alias` is set |
| `upload-url` | Presigned object storage upload URL returned by the release server |
| `file-name` | Published basename for the uploaded artifact |

## Example

```yaml
name: Publish Binary To Release Server

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v5

      - name: Build artifact
        shell: bash
        run: |
          mkdir -p dist
          echo "replace this with your real build step" > dist/widget-linux-amd64.tar.gz

      - name: Compute release id
        shell: bash
        run: |
          echo "RELEASE_ID=${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"

      - name: Upload to release server
        id: upload
        uses: your-org/release-action@v1
        with:
          release-server-url: ${{ secrets.RELEASE_SERVER_URL }}
          api-key: ${{ secrets.RELEASE_SERVER_API_KEY }}
          target-name: acme/widget
          release-id: ${{ env.RELEASE_ID }}
          file-path: dist/widget-linux-amd64.tar.gz
          content-type: application/gzip
          alias: latest

      - name: Print URLs
        run: |
          echo "Release URL: ${{ steps.upload.outputs.release-download-url }}"
          echo "Latest URL: ${{ steps.upload.outputs.alias-download-url }}"
```

## Notes

- `target-name` must be in `scope/project` form, and each segment should follow the server's allowed character rules.
- `file-name` must be a plain basename and not a path.
- The artifact upload goes to the returned `upload-url`, not back to the release server API.
- The action itself runs on Node and does not require shell-specific tooling.
- Verification checks that the public download URL is reachable without relying on a client `HEAD` request, because some presigned object-storage URLs are signed only for `GET`.
