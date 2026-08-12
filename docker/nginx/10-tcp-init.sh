#!/bin/sh
# Startup wiring for the tcp-web image. The nginx:alpine entrypoint runs every
# /docker-entrypoint.d/*.sh in name order before starting nginx, so this needs
# no ENTRYPOINT of its own. Numbered below the image's own 20-envsubst step,
# which this deliberately bypasses (see "Pick the configuration" below).
#
# Three jobs: a TLS certificate, the generated config.js, and choosing between
# the static and dev-proxy configurations.
set -eu

CERT_DIR=/etc/nginx/certs
HTML_DIR=/usr/share/nginx/html
TEMPLATE_DIR=/etc/nginx/tcp

# ---- TLS certificate -------------------------------------------------------
# HTTP/2 requires TLS in every browser (ADR-025 needs HTTP/2; no browser speaks
# cleartext h2c), so the image must always have a certificate — including on a
# developer's first run, where asking them to generate one before the stack
# starts would just mean the stack does not start.
#
# A mounted certificate always wins. mkcert is the documented way to produce a
# trusted one (docs/web-client.md); this fallback only removes the requirement
# to have done so.
if [ ! -s "$CERT_DIR/tls.crt" ] || [ ! -s "$CERT_DIR/tls.key" ]; then
  echo "tcp-web: no certificate at $CERT_DIR — generating a self-signed one."
  echo "tcp-web: browsers will warn. See docs/web-client.md to use mkcert instead."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1 \
    -keyout "$CERT_DIR/tls.key" -out "$CERT_DIR/tls.crt" 2>/dev/null
  chmod 600 "$CERT_DIR/tls.key"
else
  echo "tcp-web: using the certificate mounted at $CERT_DIR."
fi

# ---- config.js -------------------------------------------------------------
# The two values the reverse proxy cannot remove (ADR-029). The API address is
# absent by construction: it is always /api, on this same origin. A third
# value, OIDC_LOAD_USER_INFO, is optional and boolean — it is handled
# separately below and deliberately does not join this required-value loop.
#
# Fail here rather than serve an empty issuer. An app that loads with a blank
# identity provider fails at sign-in, several steps away from the cause, with
# nothing in the message pointing back to a missing container variable.
for var in OIDC_ISSUER_URL OIDC_CLIENT_ID; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "tcp-web: $var is empty. It is written into config.js, which the app" >&2
    echo "tcp-web: reads before it can sign anyone in — refusing to start." >&2
    exit 1
  fi
  # These are interpolated into a JavaScript string literal below. Rather than
  # implement escaping for values that should never need it, reject anything
  # that could close the literal or run as code.
  case "$value" in
    *[\'\"\\]* | *'<'* | *'>'*)
      echo "tcp-web: $var contains a quote, backslash or angle bracket." >&2
      echo "tcp-web: it is embedded in config.js verbatim — refusing to start." >&2
      exit 1
      ;;
  esac
done

# A JavaScript boolean, not a string. config.js is code, and the string
# 'false' is truthy — so an unquoted literal is the only correct emission, and
# anything that is not recognisably true or false is a typo worth failing on
# rather than silently reading as false.
case "${OIDC_LOAD_USER_INFO:-false}" in
  true|True|TRUE|1)        LOAD_USER_INFO=true ;;
  false|False|FALSE|0|'')  LOAD_USER_INFO=false ;;
  *)
    echo "tcp-web: OIDC_LOAD_USER_INFO must be true or false, not" >&2
    echo "tcp-web: '${OIDC_LOAD_USER_INFO}' — refusing to start." >&2
    exit 1
    ;;
esac

cat > "$HTML_DIR/config.js" <<EOF
// Generated at container start by docker/nginx/10-tcp-init.sh. Served with
// Cache-Control: no-store, and loaded ahead of the bundle. Not built, not
// bundled, not committed — this is how one image serves every environment.
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: '${OIDC_ISSUER_URL}',
  oidcClientId: '${OIDC_CLIENT_ID}',
  oidcLoadUserInfo: ${LOAD_USER_INFO},
};
EOF

# ---- Pick the configuration ------------------------------------------------
# WEB_UPSTREAM set means development: proxy to a Vite server on the host
# (docker-compose.dev-web.yml). Unset means serve the built bundle.
#
# envsubst is called with an explicit single-variable allowlist, NOT the
# image's built-in template pass. That one substitutes every defined
# environment variable, which would rewrite $uri, $host and $scheme in the
# nginx configuration the moment a variable of that name happened to exist.
if [ -n "${WEB_UPSTREAM:-}" ]; then
  echo "tcp-web: development mode — proxying to $WEB_UPSTREAM."
  # shellcheck disable=SC2016 # the single quotes ARE the allowlist — envsubst
  # parses this literal itself, and expanding it here would empty it.
  envsubst '${WEB_UPSTREAM}' \
    < "$TEMPLATE_DIR/proxy.conf.template" > /etc/nginx/conf.d/default.conf
else
  echo "tcp-web: serving the built bundle from $HTML_DIR."
  cp "$TEMPLATE_DIR/static.conf.template" /etc/nginx/conf.d/default.conf
fi
