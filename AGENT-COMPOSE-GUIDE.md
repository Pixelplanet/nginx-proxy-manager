# Compose guide for agents: making containers discoverable

This guide is for AI agents (and humans) who write `docker-compose.yml` files for services that are
published through **this fork** of Nginx Proxy Manager. Follow it and each new container shows up in
NPM's forward-host picker with the right host, port, scheme, domains and options already filled in.

> This file exists only in the fork (`Pixelplanet/nginx-proxy-manager`, branch `ux/resilient-locations`).
> The features it describes are in the upstream PRs #6018–#6021 and are not in an official NPM release yet.
> Image: `ghcr.io/pixelplanet/nginx-proxy-manager:ux-resilient-locations`.

## How discovery works (read this first)

- NPM only lists containers that are **running** and share at least one **Docker network** with the NPM
  container. A container on a network NPM isn't on is invisible, labels or not.
- Labels **do not create proxy hosts by themselves**. A user opens *Add Proxy Host* (or *Edit*), picks
  the container in the *Forward Hostname / IP* field, and NPM fills in the form from the labels. The
  user still saves.
- NPM fills only fields that are still empty or untouched. It never overwrites what the user typed. If
  another host already uses the label's domain, the domain is not filled and the dropdown shows a
  "domain in use" badge.
- NPM reaches the container **over the shared network by its container name**, so every port in a label
  is the port **inside the container**, never a port published on the host.
- Labels are read when the container is created. After changing labels, recreate the container
  (`docker compose up -d`) and use the refresh button in the picker.
- Each container is listed under its container name. With Compose it is also listed under its
  **service name**, and both entries carry the same labels.

## Labels

All labels are optional. Values are strings in YAML, so quote them.

| Label | Value | Effect when the container is picked |
|---|---|---|
| `npm.domain` | Domain names, separated by commas and/or spaces, e.g. `"app.example.com, www.app.example.com"` | Fills *Domain Names* on a new host. Names are lower-cased. A wildcard is allowed only as a leading `*.` in front of at least two labels (`*.example.com`, not `*.com`). Invalid names are dropped and shown as "ignored". At most 100 names. |
| `npm.port` | Container port, `1`–`65535` | Fills *Forward Port*. **Set this whenever the container exposes more than one port**: without it, NPM only guesses when there is exactly one exposed TCP port. |
| `npm.scheme` | `http` or `https` | Fills *Scheme*. Without it NPM uses `https` for port 443 or 8443 and `http` otherwise. Use `https` only if the app itself serves TLS on that port. |
| `npm.websocket` | boolean | Turns on *Websockets Support* (new host only). |
| `npm.block_exploits` | boolean | Turns on *Block Common Exploits* (new host only). |
| `npm.caching` | boolean | Turns on *Cache Assets* (new host only). |
| `npm.http2` | boolean | Turns on *HTTP/2 Support* once the user picks a certificate (HTTP/2 needs one). |
| `npm.hide` | boolean | Never suggest this container. It is also left out of the network DNS discovery, as long as Docker discovery works (DNS discovery alone can't read labels). Use it for databases, caches, the socket proxy and other internal services. |

Booleans accept `true`/`false`, `yes`/`no`, `on`/`off` and `1`/`0` (any case). Anything else counts as
unset.

## Rules for writing compose files

1. **Put every web-facing service on NPM's proxy network.** Use one shared, external network, e.g.
   `proxy`, created once with `docker network create proxy`. Internal-only services (databases) should
   stay on a private network of the stack instead, or carry `npm.hide: "true"`.
2. **Don't publish the web port on the host** (`ports:`) just for NPM. NPM talks to the container over
   the network. Only publish ports that something outside Docker really needs.
3. **Always set `npm.port`** to the port the app listens on inside the container, unless the image
   exposes exactly one port.
4. **Set `npm.scheme: "https"` only for apps that serve TLS themselves** (some images listen on 443
   with a self-signed certificate). NPM terminates TLS for the browser either way.
5. **Set `npm.domain`** to the domain(s) whose DNS points at NPM. Leave it out if the domain isn't known
   yet; the user can type it.
6. **Set `npm.websocket: "true"`** for apps that use websockets (chat, dashboards, code editors, most
   admin UIs with live updates).
7. **Give containers stable names.** `container_name:` (or the Compose service name) becomes the
   forward host. Renaming a container later breaks hosts that point at the old name.
8. **Label internal helpers with `npm.hide: "true"`** if they share the proxy network (databases,
   Redis, workers, socket proxy).

## Example

```yaml
services:
  wiki:
    image: requarks/wiki:2
    container_name: wiki
    restart: unless-stopped
    environment:
      DB_TYPE: postgres
      DB_HOST: wiki-db
      DB_PORT: "5432"
      DB_USER: wiki
      DB_PASS: change-me
      DB_NAME: wiki
    networks: [proxy, wiki-internal]
    labels:
      npm.domain: "wiki.example.com"
      npm.port: "3000"
      npm.scheme: "http"
      npm.websocket: "true"
      npm.block_exploits: "true"
      npm.http2: "true"

  wiki-db:
    image: postgres:16
    container_name: wiki-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: wiki
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: wiki
    networks: [wiki-internal]   # not on the proxy network, so NPM never sees it

networks:
  proxy:
    external: true              # the network NPM is on
  wiki-internal: {}
```

An app that listens on several ports and serves TLS itself:

```yaml
  nextcloud:
    image: lscr.io/linuxserver/nextcloud:latest
    container_name: nextcloud
    networks: [proxy]
    labels:
      npm.domain: "cloud.example.com"
      npm.port: "443"           # the container port, not a host port such as 444
      npm.scheme: "https"
      npm.http2: "true"
```

## The NPM side (only once per server)

Docker discovery needs read access to the Docker API through a socket proxy. Don't mount
`/var/run/docker.sock` into NPM: even read-only, it gives root on the host.

```yaml
services:
  npm:
    image: ghcr.io/pixelplanet/nginx-proxy-manager:ux-resilient-locations
    container_name: npm
    restart: unless-stopped
    ports: ["80:80", "443:443", "81:81"]
    environment:
      NPM_DOCKER_DISCOVERY: "true"
      DOCKER_HOST: "tcp://socket-proxy:2375"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
    networks: [proxy, socket-proxy]

  socket-proxy:
    image: lscr.io/linuxserver/socket-proxy:latest   # or tecnativa/docker-socket-proxy
    container_name: socket-proxy
    restart: unless-stopped
    read_only: true
    tmpfs: [/run]
    environment:
      CONTAINERS: "1"   # list containers
      NETWORKS: "1"     # list networks
      # everything else, including POST, stays at 0 (denied)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [socket-proxy]
    labels:
      npm.hide: "true"

networks:
  proxy:
    external: true
  socket-proxy:
    internal: true      # only containers attached to it can reach the proxy
```

## Checking your work

- In NPM, open *Add Proxy Host* and click into *Forward Hostname / IP*. The container should appear
  under the Docker group with its port and the state "Online".
- Picking it on a new host should fill domain, scheme, port and the switches from the labels.
- If it is missing: check that it is running, that it is on a network NPM is on, that it doesn't carry
  `npm.hide`, and that the container was recreated after the labels changed.
- If the port is empty: the image exposes several ports and `npm.port` is missing.
- If the domain is not filled: another host already uses it (the option shows "domain in use"), or the
  name was invalid (shown as "ignored").
