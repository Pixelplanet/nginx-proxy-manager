---
outline: deep
---

# Custom Locations

A proxy host can send some paths to other upstreams with custom locations. This page explains how NPM keeps a
broken or unreachable custom location from taking the whole host, or nginx, offline, and what the statuses in the
UI mean.

## How a location reaches its upstream

nginx has to turn the upstream host name into an IP address. NPM renders each custom location in one of two ways:

- **Dynamic** (the default): the host name goes into a variable and nginx looks it up through its
  [resolver](/advanced-config/#disable-nginx-resolver) on each request, caching the answer for 10 seconds. If the container behind it
  is stopped, removed or renamed, only that location answers `502 Bad Gateway` until the name resolves again. nginx
  keeps running, and the location picks up a new container IP without a reload.
- **Static**: the host name is written into the config as it is. nginx looks it up once, when the config is loaded.
  Before this change every custom location worked this way, and one unresolvable name made nginx reject the whole
  configuration.

NPM picks the mode for each location every time it writes the host's config:

| Upstream | Mode |
| --- | --- |
| IP address | static |
| Name listed in `/etc/hosts`, for example from `extra_hosts` or `host.docker.internal` | static, because nginx's resolver doesn't read `/etc/hosts` |
| Name that nginx's resolver knows | dynamic |
| Name that only the system resolver knows, for example through a search domain in `/etc/resolv.conf` | static |
| Name that doesn't resolve at all | dynamic, with status **unresolved** |
| A single nginx variable, for example `$backend` with `set $backend app;` in the advanced configuration | static, written as it is: nginx already resolves it per request |
| Location with a forward path whose advanced configuration reads `$uri` or `$document_uri` | static while the name resolves, see below |
| `NPM_LOCATION_DYNAMIC_DNS=false`, or the resolver is disabled (`DISABLE_RESOLVER`) | static |

Both modes forward requests the same way: the request path, forward path, query string and redirects from the
upstream are handled exactly as before. The dynamic mode adds a `rewrite` and a `proxy_redirect` line to do this, and
a `set $npm_loc_<n>_host` line, which runs before your advanced configuration.

::: warning $uri with a forward path
With a forward path, the dynamic mode replaces the location's path with the forward path through
`rewrite ... break`, so `$uri` and `$document_uri` hold the **rewritten** path (`/x/hello` instead of `/u/hello` for
location `/u/` with forward path `/x/`) in everything that runs after it: `proxy_set_header`, `add_header`,
`try_files`, `proxy_cache_key`, log formats, and so on. `$request_uri` is not affected.

To keep the old value, a location whose advanced configuration reads `$uri` or `$document_uri` is rendered static
as long as its upstream name resolves. When the name doesn't resolve, the location has to be dynamic (a literal
unknown name makes nginx reject the whole configuration), and `$uri` then holds the rewritten path. Variables read
outside the location's advanced configuration, for example in the host's advanced configuration or a custom log
format, are not detected: use `$request_uri` there, or set `NPM_LOCATION_DYNAMIC_DNS=false`.
:::

A forward host that is a single nginx variable, such as `$backend`, is written into the config exactly as before
(`proxy_pass http://$backend:8080;`), without the extra lines. NPM doesn't check or monitor such an upstream, and
"Cache Assets" doesn't add the nested asset location for it, because a nested location doesn't run the
`set $backend ...;` of its parent.

To go back to the old literal rendering for every location:

```yml
    environment:
      NPM_LOCATION_DYNAMIC_DNS: 'false'
```

::: tip
With "Cache Assets" enabled, assets (`.css`, `.js`, images, fonts) under a custom location are now fetched from that
location's own upstream. Before, they were fetched from the host's main upstream.
:::

## Location statuses

After every save, NPM reports a status for each custom location. The UI shows it on the location, and the API returns
it in `meta.nginx_locations` of the proxy host:

| Status | Meaning | What nginx does |
| --- | --- | --- |
| `ok` | The location is active. | Proxies to the upstream. |
| `unresolved` | The upstream name doesn't resolve right now, for example because the container is stopped. | Answers `502` for this location until the name resolves. The rest of the host works. |
| `quarantined` | nginx rejected the location, or NPM knows it would. The message says why, for example an unknown directive in its advanced configuration, or a forward path on a regular-expression location. | Answers `503` for this path. If nginx rejects even that placeholder, for example because the path itself is invalid, the location is left out. |
| `disabled` | You switched the location off. | The location isn't in the config. Requests fall through to the host's other locations. |

Fix the cause and save the host again to bring a quarantined location back. An unresolved location comes back by
itself once the upstream name resolves.

Location paths that nginx itself rejects as duplicates are rejected when you save: the same exact path (`= /x`)
twice, or the same prefix path twice (`/x` and `^~ /x` count as the same). Regular-expression (`~`, `~*`) and named
(`@name`) locations may repeat; nginx uses the first one that matches.

## When nginx rejects a host

If nginx rejects the configuration of the host itself, for example because of an error in the host's advanced
configuration, the save fails with an error that names the problem and its line. **The previous configuration stays
active**, and so do the host's previous settings:

- a new host isn't created
- a change to an existing host isn't saved
- a host you try to enable stays disabled (when only the final nginx reload fails, the new config is in place and the
  host stays enabled)

When a new host asks for a new Let's Encrypt certificate, NPM first checks that nginx accepts the host without SSL.
If it doesn't, the host is not created and no certificate is requested, so a failed attempt doesn't leave an unused
certificate behind (and doesn't count against Let's Encrypt's rate limits).

The API answers `400` with the details:

```json
{
  "error": {
    "code": 400,
    "message": "Advanced configuration: unknown directive \"proxy_passs\" (line 3).",
    "details": {
      "kind": "nginx_config",
      "scope": "host",
      "host_type": "proxy_host",
      "host_id": 12,
      "file": "/data/nginx/proxy_host/12.conf",
      "line": 31,
      "location_index": null,
      "location_path": null,
      "nginx_output": "nginx: [emerg] unknown directive \"proxy_passs\" in /data/nginx/proxy_host/12.conf:31",
      "hint": "Check the spelling of the directive. If it comes from an nginx module, that module may not be available."
    }
  }
}
```

`scope` is `host` when this host's own configuration was rejected, and `global` when a file NPM doesn't manage was
rejected, for example one of your [custom configuration files](/advanced-config/#custom-nginx-configurations).

### Other broken hosts

nginx always checks the whole configuration. When the config file of *another* host breaks the check, for example
because a certificate file was deleted, NPM no longer refuses every change. NPM first checks the configuration again
without the host being saved. If the other host's file passes then, the change being saved is at fault (for example
the same `listen ... default_server` as another host, which nginx reports at the second definition, or an `include`
of another host's file): the save fails with scope `host` and the other host is not touched. Only a host whose file
fails on its own is repaired or taken out:

- an enabled host is regenerated from the database first (without a reload, with its own custom locations
  quarantined if needed). That fixes files written by older versions and files that were changed behind NPM's back.
- only if the regenerated config still fails at host level (or the host is disabled), its file is moved to
  `<id>.conf.err` (which nginx ignores) and the host is shown as offline, with `nginx_err` starting with
  `Disabled automatically:`

Some errors don't name a config file at all, for example
`open() "/data/logs/proxy-host-5_access.log" failed (13: Permission denied)` or a missing certificate. Such an error
is blamed on the host being saved when its new config mentions the path. Otherwise the candidates are the hosts
whose config mentions the path (any directive). A mention alone is never enough: a candidate is only repaired or
taken out when the check still fails without the host being saved, **and** the error goes away when the candidate is
taken out as well. If no host passes that test, the save fails with scope `global`.

Save the affected host again once the cause is fixed.

### File directives in advanced configuration

The advanced configuration of a host or custom location can't write into or pull in configuration files NPM
generates. These are rejected with `400` (a validation error naming the directive):

- `access_log` / `error_log` with a path in `/data/nginx/` or `/etc/nginx/` (a relative path counts, nginx resolves
  it in `/etc/nginx/`). Write logs to `/data/logs/` instead. `off`, `stderr`, `syslog:`, `/dev/stdout` and paths
  starting with a variable are allowed.
- `include` of a file in `/data/nginx/proxy_host/`, `redirection_host/`, `dead_host/`, `stream/` or `default_host/`.
  Put shared snippets in `/data/nginx/custom/` (or any other directory) and include them from there.

`root`, `alias` and `include` of your own snippets are not affected. Hosts saved earlier keep working; the check runs
when a host is created or saved.

## Status in the API

Every host type (proxy, redirection, 404 and stream) has these server-owned keys in `meta`. NPM ignores them in
requests and sets them when it writes the host's config:

| Key | Description |
| --- | --- |
| `nginx_online` | `false` only when the host's config is not active in nginx |
| `nginx_err` | Why the host is offline, otherwise `null` |
| `nginx_details` | The structured details of the failure (same shape as `error.details` above), otherwise `null` |
| `nginx_checked_at` | When the config was last written |
| `nginx_locations` | Proxy hosts only: one entry per custom location, `{ index, path, status, mode, message }` |

## Startup

Two steps keep one broken host from stopping nginx, every site, and the admin UI, when the container starts:

1. Before nginx starts, the container checks the configuration with `nginx -t`, as the user nginx runs as
   (`PUID`/`PGID`). It moves the host config file named in the error (warnings don't count) to `<id>.conf.err` and
   checks again, until nginx accepts the configuration. An error that names no config file, such as a missing
   certificate or a log file nginx can't open, is blamed on a host whose config mentions that file only if moving
   that host's config aside makes the error go away (each candidate is tried in turn, the others are put back). This never stops the container
   from starting.
2. A few seconds after the backend is up, it regenerates host configs that are missing, were moved to `.err`, or were
   written by an older version (custom locations with the static form only). Then it reloads nginx once. Hosts that
   still fail are shown as offline with the reason.
3. Right after a host reboot, upstream containers may not be resolvable yet. Hosts that end offline because nginx
   could not find an upstream host (`host not found in upstream`, typical for streams), and proxy hosts with
   unresolved custom locations, are tried again after 30 seconds, 2 minutes and 5 minutes. A host that still fails
   after that stays offline until it is saved again.

To skip the second step:

```yml
    environment:
      NPM_RECONCILE_ON_START: 'false'
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NPM_LOCATION_DYNAMIC_DNS` | `true` | Resolve custom location upstreams per request where possible. `false` renders every location with the literal host name. |
| `NPM_RECONCILE_ON_START` | `true` | Regenerate missing, broken or outdated host configs after the backend starts. |
| `DISABLE_RESOLVER` | unset | No nginx resolver is generated. Custom locations then always use the static form. |
