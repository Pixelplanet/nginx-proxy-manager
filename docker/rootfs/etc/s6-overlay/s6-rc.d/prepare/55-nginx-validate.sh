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
# This script never fails the container start.

log_info 'Validating nginx config ...'

NGINX_VALIDATE_MAX=100
NGINX_VALIDATE_COUNT=0

while [ "$NGINX_VALIDATE_COUNT" -lt "$NGINX_VALIDATE_MAX" ]; do
	NGINX_VALIDATE_OUTPUT="$(nginx -t -g 'error_log off;' 2>&1 || true)"

	if echo "$NGINX_VALIDATE_OUTPUT" | grep -q 'test is successful'; then
		break
	fi

	NGINX_VALIDATE_FILE="$(echo "$NGINX_VALIDATE_OUTPUT" | grep -v '/var/log/nginx/error.log' | grep -oE '/data/nginx/(proxy_host|redirection_host|dead_host|stream)/[0-9]+\.conf' | head -n 1 || true)"

	# Some errors, eg. a missing certificate file, don't name the config file:
	# blame the first host config that references a file named in the error
	if [ -z "$NGINX_VALIDATE_FILE" ]; then
		for NGINX_VALIDATE_PATH in $(echo "$NGINX_VALIDATE_OUTPUT" | grep -E '\[emerg\]' | grep -oE '"/[^" ]+"' | tr -d '"' || true); do
			NGINX_VALIDATE_FILE="$(grep -lF "$NGINX_VALIDATE_PATH" /data/nginx/proxy_host/*.conf /data/nginx/redirection_host/*.conf /data/nginx/dead_host/*.conf /data/nginx/stream/*.conf 2>/dev/null | head -n 1 || true)"
			if [ -n "$NGINX_VALIDATE_FILE" ]; then
				break
			fi
		done
	fi

	if [ -z "$NGINX_VALIDATE_FILE" ] || [ ! -f "$NGINX_VALIDATE_FILE" ]; then
		log_error 'nginx config test failed and no host config could be blamed:'
		echo "$NGINX_VALIDATE_OUTPUT" | grep -v '/var/log/nginx/error.log' >&2 || true
		break
	fi

	log_error "Disabling ${NGINX_VALIDATE_FILE}, nginx rejected it:"
	echo "$NGINX_VALIDATE_OUTPUT" | grep -v '/var/log/nginx/error.log' | grep -E '\[(emerg|alert|crit|error)\]' | head -n 1 >&2 || true

	if ! mv -f "$NGINX_VALIDATE_FILE" "${NGINX_VALIDATE_FILE}.err"; then
		log_error "Could not move ${NGINX_VALIDATE_FILE}"
		break
	fi

	NGINX_VALIDATE_COUNT=$((NGINX_VALIDATE_COUNT + 1))
done

unset NGINX_VALIDATE_MAX NGINX_VALIDATE_COUNT NGINX_VALIDATE_OUTPUT NGINX_VALIDATE_FILE NGINX_VALIDATE_PATH
