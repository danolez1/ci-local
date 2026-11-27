# ci-local

ci-local builds your container images on your own machine when you `git push` and publishes them to your registry before git sends the commits. Your server only has to pull the finished image.

## One push, step by step

On a push to a branch listed in the repository's config, this happens:

1. Anything already in your `pre-push` hook runs first.
2. ci-local runs the checks you configured, such as your test suite.
3. It builds the commit you are pushing and publishes the image as `sha-<hash>`.
4. A push to the first listed branch also moves the `:prod` tag to that image.
5. git sends the commits to the remote.

A failed check, build or upload stops the push. If the registry already has an image for the same content, ci-local skips the build.

## Web view

`ci-local ui` starts a local web view of your runs in the background. You can search and filter the list, read each run's phases and log, follow an upload, and stop or delete one run or many.

## Developer docs

### Install

You need:

- [Bun](https://bun.sh)
- Node.js 18 or newer, for the `ci-local` launcher that starts Bun
- `docker` (OrbStack or Docker Desktop)
- [crane](https://github.com/google/go-containerregistry/tree/main/cmd/crane) (`brew install crane`)
- a container registry your server can pull from
- an ssh alias for your server, if you reach the registry over ssh
- the `zstd` command (`brew install zstd`), only for `compression: zstd`

Git hooks call `ci-local` from your `PATH`. Install it globally from npm:

```sh
bun install -g ci-local
# or run it once to see which tools are missing
bunx ci-local doctor
```

The npm release is 0.1.0, tagged `v0.1.0`. The `main` branch adds these on top of it:

- checks limited to named images
- `build_during_checks`
- several images at once (`concurrency`, `--jobs`)
- the machine-wide queues, `weight` and `ci-local queue`
- a longer timeout and retries for `bun test` inside checks

To run `main`, clone the repository and link the launcher. It has no runtime dependencies to install.

```sh
git clone https://github.com/danolez1/ci-local.git
cd ci-local
# any directory on your PATH works
ln -s "$PWD/bin/ci-local.mjs" ~/.local/bin/ci-local
```

### Machine profiles

A profile says where images are published. Put profiles in `~/.config/ci-local/config.yaml`, or `$CI_LOCAL_CONFIG_DIR/config.yaml`:

```yaml
default_profile: vps
profiles:
  vps:
    transport: ssh                  # ssh | https | direct
    ssh_host: my-vps                # alias from ~/.ssh/config, or user@host
    registry: 127.0.0.1:5000        # for ssh, the address as seen from the server
    pull_registry: 127.0.0.1:5000   # address in the deploy image printed after a push
  hub:
    transport: https
    registry: registry.example.com  # run docker login for it once
```

| Transport | How it reaches the registry |
|---|---|
| `ssh` | Port-forwards to a registry on the server's loopback. It needs no registry credentials and avoids a CDN's request-size cap. |
| `https` | Connects to the registry with your docker credentials. |
| `direct` | Behaves like `https`, for a registry you reach as it is. |

A profile also accepts `platform`, `insecure: true` (plain http) and `proxy`.

- A repository can define its own `profiles:` in `ci-local.yaml`, and these win over global ones with the same name.
- The profile comes from `--profile`, then `CI_LOCAL_PROFILE`, then `profile:` in the repository, then `default_profile`.
- An upload has three attempts in total. Layers already in the registry are skipped, and an ssh tunnel that exited is reopened.

#### Proxies

Commands started by ci-local run without `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`. Set `proxy: inherit` on a profile to keep them.

The Docker daemon has its own proxy setting, outside ci-local's control. `ci-local doctor` shows it, and a build that fails with `proxyconnect` ends with the fix.

### Repository setup

```sh
ci-local init --image acme/web          # writes ci-local.yaml
# alternative: also set up a gitignored file for public build values
ci-local init --image acme/web --build-env build.env
ci-local install-hook                   # adds the pre-push step
ci-local doctor                         # checks tools, config and the hook
```

#### ci-local.yaml reference

```yaml
version: 1
profile: vps                      # optional
branches: [main, release/*]       # pushes to these build and publish
concurrency: 3                    # main only, images of one push at once, 1 to 8
public_prefixes: [NEXT_PUBLIC_]   # optional, replaces the default prefixes
public_jwt_keys: [NEXT_PUBLIC_SUPABASE_ANON_KEY]  # optional, keys that may hold a public JWT
images:
  - name: web
    image: acme/web               # repository path in the registry
    dockerfile: Dockerfile
    context: .
    platform: linux/amd64         # default; match the server
    # target: production          # a Dockerfile stage; default is the last one
    build_env: build.env          # committed file your Dockerfile reads
    # build_env_local: local.env  # a gitignored file used the same way
    build_args_file: args.env     # committed KEY=VALUE lines passed as --build-arg
    tag_exclude: [docs, README.md]  # paths that cannot change the image
    tag_include: []               # when set, only these paths decide the tag
    # weight: 1                   # main only, docker CPUs the build needs, 1 to 64
    # build_during_checks: true   # main only
    # compression: zstd           # default is gzip
    # zstd_level: 19              # 1 to 22
checks:                           # optional, run before the build
  - name: test
    run: pnpm test
    # ttl_hours: 24               # how long a pass counts for the same tree
    # images: [web]               # main only, guard these images alone
```

- `dockerfile`, `context`, `tag_exclude` and `tag_include` at the top level are defaults for every image. A monorepo lists several entries under `images`.
- Paths must be relative and inside the repository.
- Build env files and the build args file must be regular files, with no symlinks.
- `ci-local config` prints the resolved result.

#### Build values and the secret guard

`build_env` and `build_args_file` are read from the commit. `build_env_local` is read from your working tree, copied into the build context at the same path and hashed into the tag. The run fails if that file is committed. Commit a `<file>.example` template beside it. `init --build-env` creates that template for you.

- Every key needs a public prefix. The defaults are `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `NUXT_PUBLIC_` and `EXPO_PUBLIC_`.
- Values matching common credential formats are refused, including Stripe, Flutterwave, GitHub, Slack and AWS keys, private key blocks, `sk-` keys and JWTs.
- This is a pattern match, and a secret in another format will get through. Keep secrets out of these files.
- `public_jwt_keys` allows a JWT for the keys you name. The guard cannot tell an anon key from a service-role key. List only keys that are public by design.

#### Checks

Checks run on your machine, in the repository root, in order, before the image is pushed. By default they finish before the build starts. They are code from your own repository, like a git hook.

- A pass is remembered for the tree and the command. It is recorded only when the checked-out commit is the one being built and tracked files have no edits.
- A check with `images` runs for each listed image with `CI_LOCAL_IMAGE` set to its name.
- A check without `images` guards every image. On a clean tree it runs once and the other images reuse the pass.
- `ci-local run --no-checks` skips checks for a manual run.

Every `bun test` started by a check runs with `--timeout 30000 --retry 3`, unless the command sets the flag itself. Change the values with `CI_LOCAL_TEST_TIMEOUT` (milliseconds) and `CI_LOCAL_TEST_RETRY` (`0` turns retries off).

Set `build_during_checks: true` on an image to build it while its checks run. The push waits for every check, and a failed check cancels the build. The build and the tests then share your CPU.

#### Queues

On `main`, all ci-local processes on a machine share four queues, and parallel pushes take turns in them. The run that started earliest goes first, then arrival order decides. Only the first in line may start.

| Queue | Limit |
|---|---|
| tag | One run per image and content tag. A second run waits, and skips the build when the tag is in the registry. |
| image | 3 images in flight, each from start to end. |
| checks | The checks of one image at a time. |
| build | The Docker daemon's CPUs, shared out by each image's `weight`. |

- Builds that share a few CPUs can finish far later than the same builds one after another. On one machine the median build took 43 seconds alone and 505 seconds beside others. Give a heavy build a `weight` equal to the CPU count.
- `concurrency` and `ci-local run --jobs N` cap the images of one push. The image queue allows 3 at once, and a cap above 3 has no effect.
- `ci-local queue` lists who holds and who waits. Claims left by a killed process are dropped.

#### zstd layers

With `compression: zstd`, ci-local recompresses each layer with the `zstd` CLI before the push. On a 1.15 GB image, zstd cut the upload from 601.7 MB to 406.3 MB.

- Compressed layers are cached for 14 days and reused when a layer is unchanged.
- The server pulling the image needs Docker Engine 23 or newer.
- The image is pushed with an OCI manifest straight from the build export, and `--keep-local` has no effect on it.

### The pre-push hook

```sh
ci-local install-hook                  # picks husky, core.hooksPath or .git/hooks
ci-local install-hook --kind husky     # .husky/pre-push
ci-local install-hook --kind githooks  # .githooks/pre-push, and points core.hooksPath there
ci-local install-hook --remove
```

- The installer appends one marked block at the end of the hook, below your own steps. Run it again to move the block back to the end.
- `doctor` fails when the block is not last, when the hook is not a shell script, or when a top-level `exit` comes before the block.
- Pushed refs are read from stdin. If an earlier step already read them into a `refs` variable, that value is replayed. With neither, ci-local builds the checked-out branch when it is listed.
- If `ci-local` is missing from `PATH`, the hook prints a warning and the push goes through with no checks or image from ci-local.
- `CI_LOCAL_SKIP_IMAGE=1 git push` skips ci-local once.

### Manual runs

```sh
ci-local run                                   # HEAD of this repository
ci-local run --image web --sha v1.2 --dry-run
ci-local run --retag                           # also move :prod to this build
ci-local run --no-push --platform linux/arm64  # build and load locally only
ci-local run --background                      # detach and print the run id
printf 'repo: ~/work/app\nsha: main\nimages: [web]\ndry_run: true\n' | ci-local run --stdin
```

The `--stdin` job is YAML or JSON with `repo`, `sha`, `images`, `profile`, `platform`, `push`, `retag`, `dry_run` and `keep_local`. Unknown keys and wrong types are rejected. `--stdin` cannot be combined with `--background`.

`:prod` moves only for a hook push to the first entry of `branches`, or with `--retag`. Other runs publish the `sha-` tag alone.

### Runs and logs

```sh
ci-local status               # recent runs, --json for the records
ci-local logs -f              # follow the newest log
ci-local watch                # live terminal view
ci-local ui                   # web view in the background, http://127.0.0.1:7777
ci-local ui start --open      # the same, and open the browser
ci-local ui serve             # web view in this terminal
ci-local ui status            # also restart, logs
ci-local ui-stop              # same as ci-local ui stop
ci-local ui install           # start at login (macOS); ui uninstall removes it
```

Each run writes `run.json` and a log under `~/.local/state/ci-local/runs/`, or under `$CI_LOCAL_STATE_DIR`. A run whose process was killed shows as `interrupted`. Over the `ssh` transport, the upload also reports bytes sent and the current rate.

#### Web view details

- The run list can be filtered by status and repository and searched. A repositories page shows the success rate and median build time.
- There are light, dark and system themes. Press `?` for the keyboard shortcuts.
- Stop signals the ci-local process behind a run, and a push waiting on that run fails. Delete removes a finished run's record and log.
- `POST /api/runs/bulk` takes `{"action": "stop" | "delete", "ids": [...]}` with at most 200 ids.
- The server listens on loopback only. Stop and delete requests need the header `x-ci-local: 1`, and a browser request must come from the page's own origin.
- `--port` picks another port.
- If the login service is installed, it starts the server again after `ui-stop`.

### Tags and build contents

- The build context is the output of `git archive`: committed files, plus `build_env_local` when you set it.
- The tag is `sha-` plus a hash of the committed files that can change the image: everything minus `tag_exclude`, narrowed to `tag_include` when set.
- The hash also covers the platform, Dockerfile path, context, target and the content of `build_env_local`.
- The platform comes from `--platform`, the image, the profile, then `linux/amd64`.

### zot registry settings

The notes below apply to version 2.1.21 of zot, an OCI registry.

- The default limit in zot is 60 seconds for reading a request, body included, and 60 seconds for writing the response. For large layers, set `http.readTimeout` and `http.writeTimeout` higher, for example `30m`.
- The response to a Docker v2 manifest is 415 (`MANIFEST_INVALID`) unless `http.compat` lists `docker2s2`. Images pushed with `compression: zstd` use OCI manifests and need no such setting.

### Deploying

Each push prints the deploy image. With the `ssh` example above, the server pulls `127.0.0.1:5000/<image>:prod` or the exact `:sha-...` tag from its own registry.

### Developing ci-local

```sh
bun install
bun run test
bun run typecheck
```

The tests stand in for `docker` and `crane` with stub scripts. Tests that need `zstd` are skipped when it is missing.

| Path | Contents |
|---|---|
| `bin/ci-local.mjs` | launcher |
| `src/cli.ts` | commands |
| `src/engine.ts`, `src/queue.ts`, `src/checks.ts` | one image run, the queues, the checks |
| `src/registry.ts`, `src/recompress.ts` | push and tunnel, zstd |
| `src/ui/` | web view server and page |
| `examples/` | sample config files |
| `test/` | tests |

## License

[MIT](LICENSE). The web view ships the Urbanist font under the SIL Open Font License ([copy](src/ui/fonts/OFL.txt)).
