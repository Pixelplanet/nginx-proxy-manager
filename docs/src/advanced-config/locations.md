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
| `NPM_LOCATION_DYNAMIC_DNS=false`, or the resolver is disabled (`DISABLE_RESOLVER`) | static |

Both modes forward requests the same way: the request path, forward path, query string and redirects from the
upstream are handled exactly as before. The dynamic mode adds a `rewrite` and a `proxy_redirect` line to do this, and
a `set $npm_loc_<n>_host` line, which runs before your advanced configuration.

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

Duplicate location paths in one host are rejected when you save.

## When nginx rejects a host

If nginx rejects the configuration of the host itself, for example because of an error in the host's advanced
configuration, the save fails with an error that names the problem and its line. **The previous configuration stays
active**, and so do the host's previous settings:

- a new host isn't created
- a change to an existing host isn't saved
- a host you try to enable stays disabled

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
because a certificate file was deleted, NPM no longer refuses every change. Instead it repairs or takes out that host:

- a proxy host is regenerated from the database first, which fixes files written by older versions
- if that doesn't help, its file is moved to `<id>.conf.err` (which nginx ignores) and the host is shown as offline,
  with `nginx_err` starting with `Disabled automatically:`

Save the affected host again once the cause is fixed.

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

1. Before nginx starts, the container checks the configuration with `nginx -t`. It moves any host config file that
   nginx blames to `<id>.conf.err` and checks again, until nginx accepts the configuration. This never stops the
   container from starting.
2. A few seconds after the backend is up, it regenerates host configs that are missing, were moved to `.err`, or were
   written by an older version (custom locations with the static form only). Then it reloads nginx once. Hosts that
   still fail are shown as offline with the reason.

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
