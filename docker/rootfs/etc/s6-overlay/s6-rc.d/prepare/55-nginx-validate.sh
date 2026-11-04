#!/command/with-contenv bash
# shellcheck shell=bash

# Makes sure nginx can start: when `nginx -t` fails because of the config file of a
# proxy/redirection/404 host or stream, that file is moved to <file>.err (which nginx
# does not include) and the test is repeated. Without this one broken host, for example
# a custom location pointing at a container that is not running, keeps nginx and with it
# every site and the admin UI from starting.
#
# The backend regenerates these hosts once it is up and marks the ones that are still
# broken as offline in the UI.
#
# The test runs as the user nginx and the backend run as (PUID:PGID). `nginx -t` creates
# files (log files on a fresh volume, the pid file, ...) and as root they would end up
# owned by root, which nginx running as PUID can't open.
#
# This script never fails the container start.

log_info 'Validating nginx config ...'

# Earlier versions ran this test as root and left root owned files behind: log files of
# every host (/data/logs/proxy-host-1_access.log, ...), the pid file, temp and cache
# directories and /etc/nginx/nginx/off (from `error_log off`). 30-ownership.sh doesn't
# look inside a directory that is already owned by PUID:PGID, and nginx running as
# PUID fails to open them ("Permission denied", no file or line to blame). Give back
# whatever isn't owned by the runtime user. Only the files that are wrong are touched.
if [ "$PUID" != '0' ]; then
	for NGINX_VALIDATE_PATH in /data/logs /var/log/nginx /run/nginx /tmp/nginx /var/lib/nginx /var/cache/nginx /etc/nginx/nginx/off; do
		if [ -e "$NGINX_VALIDATE_PATH" ]; then
			find "$NGINX_VALIDATE_PATH" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
		fi
	done
fi

NGINX_VALIDATE_MAX=100
NGINX_VALIDATE_COUNT=0
NGINX_VALIDATE_HOSTS='/data/nginx/(proxy_host|redirection_host|dead_host|stream)/[0-9]+\.conf'

while [ "$NGINX_VALIDATE_COUNT" -lt "$NGINX_VALIDATE_MAX" ]; do
	NGINX_VALIDATE_OUTPUT="$(s6-setuidgid "$PUID:$PGID" nginx -t -g 'error_log /dev/null;' 2>&1 || true)"

	if echo "$NGINX_VALIDATE_OUTPUT" | grep -q 'test is successful'; then
		break
	fi

	# Only the error itself names the broken file: warnings before it (eg. a deprecated
	# "listen ... http2" in a healthy host) name files too
	NGINX_VALIDATE_ERROR="$(echo "$NGINX_VALIDATE_OUTPUT" | grep -v '/var/log/nginx/error.log' | grep -E '\[(emerg|alert|crit)\]' | head -n 1 || true)"
	NGINX_VALIDATE_FILE="$(echo "$NGINX_VALIDATE_ERROR" | grep -oE "in ${NGINX_VALIDATE_HOSTS}:[0-9]+" | head -n 1 | sed -E 's/^in //; s/:[0-9]+$//' || true)"

	# Some errors, eg. a missing certificate file, don't name the config file: blame the
	# first host config that loads a file named in the error with one of its own ssl_*
	# directives. Any other mention (eg. its access_log) is not enough.
	if [ -z "$NGINX_VALIDATE_FILE" ] && ! echo "$NGINX_VALIDATE_ERROR" | grep -qE ' in /[^ ]+:[0-9]+$'; then
		for NGINX_VALIDATE_PATH in $(echo "$NGINX_VALIDATE_ERROR" | grep -oE '"/[^" ]+"' | tr -d '"' || true); do
			for NGINX_VALIDATE_CANDIDATE in $(grep -lF "$NGINX_VALIDATE_PATH" /data/nginx/proxy_host/*.conf /data/nginx/redirection_host/*.conf /data/nginx/dead_host/*.conf /data/nginx/stream/*.conf 2>/dev/null || true); do
				if awk -v p="$NGINX_VALIDATE_PATH" '{ sub(/#.*/, "") } $1 ~ /^ssl_[a-z_]+$/ && index($0, p) { found = 1 } END { exit !found }' "$NGINX_VALIDATE_CANDIDATE"; then
					NGINX_VALIDATE_FILE="$NGINX_VALIDATE_CANDIDATE"
					break 2
				fi
			done
		done
	fi

	if [ -z "$NGINX_VALIDATE_FILE" ] || [ ! -f "$NGINX_VALIDATE_FILE" ]; then
		log_error 'nginx config test failed and no host config could be blamed:'
		echo "$NGINX_VALIDATE_OUTPUT" | grep -v '/var/log/nginx/error.log' >&2 || true
		break
	fi

	log_error "Disabling ${NGINX_VALIDATE_FILE}, nginx rejected it:"
	echo "$NGINX_VALIDATE_ERROR" >&2

	if ! mv -f "$NGINX_VALIDATE_FILE" "${NGINX_VALIDATE_FILE}.err"; then
		log_error "Could not move ${NGINX_VALIDATE_FILE}"
		break
	fi

	NGINX_VALIDATE_COUNT=$((NGINX_VALIDATE_COUNT + 1))
done

unset NGINX_VALIDATE_MAX NGINX_VALIDATE_COUNT NGINX_VALIDATE_HOSTS NGINX_VALIDATE_OUTPUT NGINX_VALIDATE_ERROR NGINX_VALIDATE_FILE NGINX_VALIDATE_PATH NGINX_VALIDATE_CANDIDATE
