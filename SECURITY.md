# Security

DSH Remote Hub currently serves one owner and their trusted devices. A valid Environment account/key can invoke all registered resources. DSH Web access grants control of that owner's conversations and environment. Device tools run with the target user's filesystem and process permissions.

## Access boundaries

Workspaces set the default execution directory. Pi tools can access absolute paths, parent directories and symlinks where the target OS user has permission. Use a dedicated OS account when a device needs a narrower execution scope.

Environment listeners bind to loopback. Use SSH forwarding or a TLS reverse proxy for remote access. Credentials belong in Authorization headers. Private connection files, Web launch links, model credentials, installer packages and runtime backups should be kept under owner control.

Generated installers carry expiring pairing credentials. Pairing uses a pinned server SSH host key, and each registered device receives an independent key restricted to the required entry and forwarding paths. Linux installation has been tested on real devices; native macOS and Windows installation remains preview functionality.

## Shared execution

Other agents may operate on the same files or processes. Each call names an explicit target. Cancellation affects its invocation; a timeout or lost response can follow a partial mutation. The service does not automatically replay these operations. Inspect the target before retrying.

## Reporting

Report sensitive findings through [GitHub private vulnerability reporting](https://github.com/kingguuu8-svg/dsh-remote-hub/security/advisories/new). Avoid attaching keys, installer payloads, launch URLs, session transcripts or private host configuration.

Include the affected version, operating systems, minimal reproduction using synthetic data, and the expected access boundary. General connection or installation failures can use the regular bug template after removing private information.
