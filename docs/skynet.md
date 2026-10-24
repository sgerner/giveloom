# Skynet deployment

The Skynet host runs the public `sgerner/giveloom` repository at
`/home/skynet/opt/stacks/giveloom`. The standalone `compose.skynet.yml` stack
uses the Compose project `giveloom`; it does not start the local reverse proxy.
The existing Caddy/Cloudflare path serves `give.stevengerner.com` and forwards
traffic to the stack's web service. Do not publish another host port or start
the base Compose file on this machine.

## Initial setup

Keep the repository on its `main` branch with no local modifications. Create
the host state directory `/home/skynet/opt/appdata/giveloom/updater` with
permissions `0700`, owned by the account running Docker, and initialize its
`deployed-sha` file to the full 40-character SHA of the revision currently
deployed. The updater refuses to run without this marker. The directory also
holds private paired backups and an automatic-update pause marker after a
migration error.

Configure the Compose `.env` in the repository with the required database
bootstrap, app, and migration credentials, app/session/signing secrets,
`APP_DOMAIN=give.stevengerner.com`, and the SES settings required for the
configured mail flows. Keep `.env` private (`chmod 600`). SES sending also
requires valid provider credentials, a verified SES identity, production
access and the configured SNS callback topic; automatic deployment does not
configure those external services. Set the Cloudflare DNS record and existing
Caddy routing separately as described by the host's network setup.

Start the stack from the repository directory with the standalone file and
project name:

```sh
docker compose --project-name giveloom --file compose.skynet.yml up -d --wait postgres redis db-bootstrap migrate web worker clamav
docker compose --project-name giveloom --file compose.skynet.yml up -d updater
```

The updater container needs the Docker CLI and access to `/var/run/docker.sock`.
It mounts the repository at the same absolute path as the host, so Compose
build contexts and bind mounts resolve correctly through the Docker daemon.
The state directory is mounted at `/state`; the updater fetches the configured
public GitHub repository's `main` branch every 900 seconds by default. It
accepts only a fast-forward from `main` and never resets the checkout. New app images are built and tagged with
the full Git SHA before downtime. It holds an exclusive lock in the state
directory, uses Git's `safe.directory` setting for the mounted checkout, and
limits fetch, build, and migration commands to 30 minutes by default.

## Update behavior

For each new revision, the updater builds the `web`, `worker`, and `migrate`
image, ensures PostgreSQL and Redis are healthy, then stops web and worker.
Before changing the schema it writes a database custom dump and a tar archive
of `uploads/` and `exports/` to a timestamped directory under
`/home/skynet/opt/appdata/giveloom/updater/backups/`. Both files are mode `0600`
inside a mode `0700` directory. A missing or empty backup aborts the update.

It then runs `db-bootstrap`, runs migrations with the SHA-tagged image, and
starts web and worker with health checks. The deployed SHA is atomically
advanced only after both services become healthy; the matching `APP_VERSION`
is also saved to the private `.env` for subsequent manual Compose commands.
Build, backup, and other pre-migration failures leave the marker unchanged and
are retried on a later poll. If migration fails or the new services fail their
health checks, web and worker stay stopped, the marker stays on the old
revision, and `blocked-sha` pauses further attempts until an operator has
reviewed the migration and database state. The updater does not automatically
roll back database changes.

The database and file archives contain sensitive donor data. Keep the state
directory private, include it in encrypted off-host backup policy, and apply a
retention policy that meets operational requirements. The updater does not
delete old backups.

## Operations and recovery

Run commands from `/home/skynet/opt/stacks/giveloom`:

```sh
docker compose --project-name giveloom --file compose.skynet.yml ps
docker compose --project-name giveloom --file compose.skynet.yml logs -f updater
docker compose --project-name giveloom --file compose.skynet.yml logs --tail=200 web worker migrate
```

After editing updater or Compose configuration, restart the updater so its next
iteration uses the new script/configuration:

```sh
docker compose --project-name giveloom --file compose.skynet.yml restart updater
```

To run one polling iteration for a controlled maintenance check, run
`docker compose --project-name giveloom --file compose.skynet.yml run --rm -e UPDATE_ONCE=true updater`.
The normal service uses its 900-second poll loop. Restore and rollback are operator-led because
database migrations may not be reversible. Preserve the paired backup, stop
application traffic, review the migration failure, and rehearse restoration on
a copy before restoring production. The repository's `ops/restore.sh` targets
the base Compose stack and must not be run unchanged on Skynet; use the named
Skynet Compose file and the selected backup paths when carrying out recovery.
