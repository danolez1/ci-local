# ci-local

Build container images on your own machine and publish them to a registry from a git pre-push hook, so the server that runs them never builds anything.

When you push a configured branch, the hook builds the commit you are pushing, publishes it as `sha-<hash>`, moves `:prod`, and only then lets the push go. If the build fails, the push stops.

## What it looks like

`ci-local ui` is a local web view of every run: filters, an Actions menu per run, light and dark themes.

![The runs list with the Actions menu open](https://raw.githubusercontent.com/danolez1/ci-local/main/docs/images/runs-list.png)

A run page shows the phases (checks, build, compress, push) with their log, and while an image uploads, the layers done, bytes sent and rate. Stop and Delete are on the page.

![A run in its push phase with the upload progress bar](https://raw.githubusercontent.com/danolez1/ci-local/main/docs/images/run-push.png)

![The runs list in the dark theme](https://raw.githubusercontent.com/danolez1/ci-local/main/docs/images/runs-dark.png)

## Install

You need [Bun](https://bun.sh), `docker` (OrbStack or Docker Desktop) and [crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane) (`brew install crane`). The ssh transport also needs an ssh alias for your server, and `compression: zstd` needs the `zstd` command (`brew install zstd`).

```sh
npm install -g github:danolez1/ci-local        # puts `ci-local` on PATH
# or run it once without installing
npx github:danolez1/ci-local doctor
bunx github:danolez1/ci-local doctor
```

Git hooks call `ci-local` from PATH, so use the global install for repos you want hooked.

## Set up a machine

Profiles say where images are published. Put them in `~/.config/ci-local/config.yaml` (or `$CI_LOCAL_CONFIG_DIR/config.yaml`):

```yaml
default_profile: vps
profiles:
  vps:
    transport: ssh              # ssh | https | direct
    ssh_host: my-vps            # alias from ~/.ssh/config, or user@host
    registry: 127.0.0.1:5000    # for ssh: the address as seen from the server
    pull_registry: 127.0.0.1:5000   # only used for the hint printed after a push
  hub:
    transport: https
    registry: registry.example.com  # docker login registry.example.com once
```

| transport | how it reaches the registry |
|---|---|
| `ssh` | Port-forward to a registry that only listens on the server's loopback. No credentials, and no request-size cap from a CDN in front (Cloudflare documents a 100 MB request-body limit on Free and Pro, which breaks large image layers). A dropped connection is retried up to three times, reopening the tunnel if ssh exited, and layers already uploaded are skipped. |
| `https` | Straight to the registry with the credentials in `~/.docker/config.json`. |
| `direct` | Same as `https` for a registry you reach as is. Set `insecure: true` for plain http. |

Every command ci-local runs has `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` removed from its environment, so a stale proxy in your shell never reaches docker or crane. Set `proxy: inherit` on a profile to keep them. The Docker daemon's own proxy is out of ci-local's reach (on OrbStack it follows `network_proxy`); `ci-local doctor` shows it, and a build that fails with `proxyconnect` ends with the fix.

A repo can define its own `profiles:` in `ci-local.yaml`; they win over global ones with the same name. The profile is chosen by, in order: `--profile`, `CI_LOCAL_PROFILE`, `profile:` in the repo, `default_profile`.

## Set up a repo

```sh
ci-local init --image acme/web      # writes ci-local.yaml
ci-local init --image acme/web --build-env build.env   # also the .example template and the .gitignore line
ci-local install-hook               # adds the pre-push step
ci-local doctor                     # checks tools, config and the hook
```

`ci-local.yaml`:

```yaml
version: 1
profile: vps                    # optional
branches: [main, release/*]     # pushes to these build and publish
public_prefixes: [NEXT_PUBLIC_] # optional, keys allowed in build_env
images:
  - name: web
    image: acme/web             # repository path in the registry
    dockerfile: Dockerfile
    context: .
    platform: linux/amd64       # default; match the server's architecture
    # target: production        # a Dockerfile stage; default is the last stage
    build_env: build.env        # committed, public values only
    # build_env_local: build.env  # instead of build_env, to keep the file gitignored (never both)
    build_args_file: args.env       # committed KEY=VALUE lines passed as --build-arg
    tag_exclude: [docs, README.md]    # paths that cannot change the image
    tag_include: []             # if set, only these paths decide the tag
    # compression: zstd        # default gzip; zstd layers are roughly a third smaller
    # zstd_level: 19            # 1 to 22, default 19
checks:                         # optional, run on this machine before anything is built
  - name: test
    run: pnpm test              # a shell command run in the repository root
    # ttl_hours: 24             # how long a pass counts for the same tree; default until the tree changes
```

`checks` are commands the repository wants green before an image exists, usually its tests. They run in the repository root on your machine (so they can reach a local test database), in order, before docker or the registry tunnel is opened, and a failing one stops the run and with it the push. A pass is remembered for the tree it ran on in ci-local's state folder, so pushing the same content again, or a second image from the same commit, skips it. The pass is only remembered when the checked-out commit is the one being built and tracked files have no edits; otherwise the check runs and says so in the log. Checks apply to the branches listed in `branches`. `ci-local run --no-checks` skips them for a manual run. They are code from your own repository, like a git hook.

`compression: zstd` exports the image as an OCI layout instead of loading it into Docker, recompresses each layer with the `zstd` CLI (`brew install zstd`) and pushes that. In a real 1.15 GB Next.js image it cut the upload from 601.7 MB to 406.3 MB at level 19. Recompressed layers are cached by content under the state directory for 14 days, so only changed layers are compressed again, and the push skips layers the registry already has. The server that pulls the image needs Docker Engine 23 or newer (or containerd 1.5 or newer). The image is pushed with an OCI manifest, so a registry that refuses Docker v2 manifests accepts it. `--keep-local` has no effect because the image never enters the local daemon.

`build_env_local` is for values you would rather not commit: the file is read from your working tree, checked like `build_env`, copied into the build context at the same path, and hashed into the tag so a changed value never reuses an old image. Use one of `build_env` or `build_env_local` per file. Commit a `<file>.example` template next to it; `init --build-env` creates it and adds the real file to `.gitignore`, and `doctor` warns when the template is missing. Paths (`dockerfile`, `context`, `build_env`, `build_env_local`, `build_args_file`) must be relative and stay inside the repo, and the env files must be regular files, not symlinks. Top-level `dockerfile`, `context`, `tag_exclude` and `tag_include` are defaults for every image, so a monorepo lists several entries under `images`. `ci-local config` prints the resolved result.

## The hook

```sh
ci-local install-hook                 # detects husky, a core.hooksPath directory, or .git/hooks
ci-local install-hook --kind husky    # force .husky/pre-push
ci-local install-hook --kind githooks # .githooks/pre-push and core.hooksPath=.githooks
ci-local install-hook --remove
```

It appends one marked block at the very end of the hook, so the image build is the last gate before git pushes. The order of a push to a configured branch is: your own hook steps, then ci-local (the repository's checks, the build, publishing the image to the registry, moving `:prod`), and only after all of that git sends the commits to the remote. Publishing the image is not the git push; that always comes last. Nothing is added above your existing steps. Running the install again moves the block back to the last line if someone appended a step after it, and `doctor` fails when it is not last, when the hook is not a shell script, or when a top-level `exit` comes before the block.

The pushed refs reach ci-local from stdin. Husky hooks that already read stdin into a `refs` variable get that variable replayed; if neither is available it builds the checked-out branch when that branch is listed in `branches`. An existing `core.hooksPath` is left alone and the hook is written where it points.

If `ci-local` is not on PATH the hook prints a warning and lets the push through, so a machine without the tool is never blocked.

`CI_LOCAL_SKIP_IMAGE=1 git push` skips it once.

## Run it by hand or from another tool

```sh
ci-local run                                   # HEAD of this repo
ci-local run --image web --sha v1.2 --dry-run
ci-local run --retag                           # also move :prod to this build
ci-local run --no-push --platform linux/arm64  # build and load locally only
printf 'repo: ~/work/app\nsha: main\nimages: [web]\ndry_run: true\n' | ci-local run --stdin
```

The stdin job is YAML or JSON with `repo` (a leading `~` works), `sha`, `images`, `profile`, `platform`, `push`, `retag`, `dry_run` and `keep_local`. Unknown keys and wrong types are rejected, so a typo cannot turn a dry run into a real push. The hook itself reads git's pre-push lines on stdin (`ci-local hook pre-push`).

`:prod` moves only for a hook run on the first entry of `branches`, or when you pass `--retag`. Other runs publish the immutable `sha-` tag and leave `:prod` alone. `--keep-local` keeps the loaded image.

## Watching runs

Each run writes a record (`run.json`) and a log under `~/.local/state/ci-local/runs/` (`$CI_LOCAL_STATE_DIR` moves it). The record has the image, sha, branch, tag, trigger (`hook` or `manual`), status, per-phase timings, the deploy image once it is published, and the pid of the process running it. A run whose process was killed shows as `interrupted`. The log marks each phase as a group, which the web view folds. While an image is pushing, the log gets a line for each finished layer and a status line every 15 seconds (bytes sent, rate, layers done), and the record's `push` field holds the same numbers.

```sh
ci-local status                  # recent runs
ci-local logs -f                 # follow the newest log
ci-local watch                   # live terminal view
ci-local ui                      # web view in this terminal, http://127.0.0.1:7777
ci-local ui start --open         # run the web view in the background and open it
ci-local ui status | stop | restart | logs
ci-local ui install              # start it at login (macOS LaunchAgent); ui uninstall removes it
ci-local run --background        # build detached from the terminal; prints the run id to follow
```

The web view has paged, filterable run lists (status, repository, search), a run page with phases and a filterable log, a repositories page with success rate and median build time, light, dark and system themes, and keyboard shortcuts (`?` lists them). While an image is pushing, the run page shows layers done, bytes sent and the current rate (bytes are counted on the ssh transport only; other transports show layers). Each run has Stop and Delete: the run page shows both buttons, and the list has an Actions menu on every row. Stop signals the ci-local process running it (after checking that the process really is ci-local), which cancels its docker build, upload and ssh tunnel and marks the run failed, and a push waiting on it fails. Delete removes a finished run's record and log. Changes only work from the page's own origin and carry a marker header, so another site open in your browser cannot trigger them, and the server binds to loopback because logs can name internal hosts. The page uses the Urbanist font (SIL Open Font License, copy in `src/ui/fonts/OFL.txt`), served by the tool itself so it works offline, and logs use a terminal monospace stack; the CSS variables `--log-size` and `--log-leading` in the page's `:root` set their size and spacing. `--port` picks another port; the background copy remembers its port in `ui.json` in the state directory.

## What gets built and tagged

- The image is built from `git archive <sha>`, the files a clone would see. Untracked and ignored files never reach it, so a build that depends on a local-only file fails on your machine first.
- The tag is `sha-` plus a hash of the committed files that can change the image (everything minus `tag_exclude`, or only `tag_include`), the platform, the Dockerfile path and the `target`. A commit that changes nothing relevant finds its tag already in the registry and skips the build.
- `build_env`, `build_env_local` and `build_args_file` may only hold public values. Every key needs a public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_` by default), and values matching common credential formats (Stripe, GitHub, Slack and AWS keys, private key blocks, JWTs, `sk-` keys) are refused. That is a pattern check, not proof a value is safe. Secrets stay in the deploy platform's environment.

## Registry notes

Large images expose limits that a small test never hits.

- **Per-request time limits.** zot v2.1.21 answers a layer upload that lasts over 60 seconds with a 500 `i/o timeout`, even while bytes are flowing, and crane reports it as `EOF` or `use of closed network connection`. Set `http.readTimeout` and `http.writeTimeout` (for example `30m`) in zot's `config.json`. A registry behind a CDN has its own request-body cap, which is why the `ssh` transport goes to the registry directly.
- **Config changes need a restart.** A redeploy from git updated the bind-mounted `config.json` on the server without restarting the zot container, so the old settings stayed live. Restart the container after changing the file and check its start time.
- **Docker v2 manifests.** crane pushes a `docker save` tarball with a Docker v2 manifest. zot v2.1.21 refuses it with 415 (crane shows `MANIFEST_INVALID`) unless `http.compat` lists `docker2s2`. Images with `compression: zstd` are pushed with an OCI manifest and do not need that setting.
- **Slow links.** A first push of a large image takes as long as the upload, so watch it in the web view. Later pushes only send the layers that changed, so keep rarely changing layers (dependencies, base packages) before frequently changing ones in the Dockerfile and avoid `chown -R` or `chmod -R` on a copied tree, which stores every file a second time.

## Deploying

The server pulls from its own loopback registry: `127.0.0.1:5000/<image>:prod`, or the exact `:sha-...` each run prints. In Dokploy, an Application uses the Docker provider with that image, and a Compose project uses `image:` instead of `build:`. A mutable `:prod` is only re-pulled when the redeploy forces a pull; the immutable tag always is. Runtime environment variables stay in the platform.

## Development

```sh
bun install
bun test            # unit and end-to-end tests, no docker or network needed
bun run typecheck
```

MIT licensed.
