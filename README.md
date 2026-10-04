# ci-local

Build container images on your own machine and publish them to a registry from a git pre-push hook, so the server that runs them never builds anything.

When you push a configured branch, the hook builds the commit you are pushing, publishes it as `sha-<hash>`, moves `:prod`, and only then lets the push go. If the build fails, the push stops.

## Install

You need [Bun](https://bun.sh), `docker` (OrbStack or Docker Desktop) and [crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane) (`brew install crane`). The ssh transport also needs an ssh alias for your server.

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
| `ssh` | Port-forward to a registry that only listens on the server's loopback. No credentials, and no request-size cap from a CDN in front (Cloudflare documents a 100 MB request-body limit on Free and Pro, which breaks large image layers). |
| `https` | Straight to the registry with the credentials in `~/.docker/config.json`. |
| `direct` | Same as `https` for a registry you reach as is. Set `insecure: true` for plain http. |

A repo can define its own `profiles:` in `ci-local.yaml`; they win over global ones with the same name. The profile is chosen by, in order: `--profile`, `CI_LOCAL_PROFILE`, `profile:` in the repo, `default_profile`.

## Set up a repo

```sh
ci-local init --image acme/web      # writes ci-local.yaml
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
    build_env: infra/build.env  # committed, public values only
    build_args_file: infra/args.env   # committed KEY=VALUE lines passed as --build-arg
    tag_exclude: [docs, README.md]    # paths that cannot change the image
    tag_include: []             # if set, only these paths decide the tag
```

Top-level `dockerfile`, `context`, `tag_exclude` and `tag_include` are defaults for every image, so a monorepo lists several entries under `images`. `ci-local config` prints the resolved result.

## The hook

```sh
ci-local install-hook                 # detects husky, a core.hooksPath directory, or .git/hooks
ci-local install-hook --kind husky    # force .husky/pre-push
ci-local install-hook --kind githooks # .githooks/pre-push and core.hooksPath=.githooks
ci-local install-hook --remove
```

It appends one marked block at the very end of the hook, so the image build is the last gate before git pushes. Nothing is added above your existing steps. Running the install again moves the block back to the last line if someone appended a step after it, and `doctor` fails when it is not last, when the hook is not a shell script, or when a top-level `exit` comes before the block.

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

Each run writes a record and a log under `~/.local/state/ci-local/runs/` (`$CI_LOCAL_STATE_DIR` moves it).

```sh
ci-local status          # recent runs
ci-local logs -f         # follow the newest log
ci-local watch           # live terminal view
ci-local ui --port 7777  # web view on http://127.0.0.1:7777
```

The web view is read-only and binds to loopback, because logs can name internal hosts.

## What gets built and tagged

- The image is built from `git archive <sha>`, the files a clone would see. Untracked and ignored files never reach it, so a build that depends on a local-only file fails on your machine first.
- The tag is `sha-` plus a hash of the committed files that can change the image (everything minus `tag_exclude`, or only `tag_include`), the platform and the Dockerfile path. A commit that changes nothing relevant finds its tag already in the registry and skips the build.
- `build_env` and `build_args_file` may only hold public values. Every key needs a public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_` by default), and values matching common credential formats (Stripe, GitHub, Slack and AWS keys, private key blocks, JWTs, `sk-` keys) are refused. That is a pattern check, not proof a value is safe. Secrets stay in the deploy platform's environment.

## Deploying

The server pulls from its own loopback registry: `127.0.0.1:5000/<image>:prod`, or the exact `:sha-...` each run prints. In Dokploy, an Application uses the Docker provider with that image, and a Compose project uses `image:` instead of `build:`. A mutable `:prod` is only re-pulled when the redeploy forces a pull; the immutable tag always is. Runtime environment variables stay in the platform.

## Development

```sh
bun install
bun test            # unit and end-to-end tests, no docker or network needed
bun run typecheck
```

MIT licensed.
