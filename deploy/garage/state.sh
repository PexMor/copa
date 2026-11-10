# Sourced (not executed) by init.sh, make s3-down, scripts/*-s3.sh.
# Persistent state (secrets, key info, Garage metadata + data) lives outside the repo.
: "${COPA_S3_DIR:=${XDG_CONFIG_HOME:-$HOME/.config}/copa/s3-garage}"
export COPA_S3_DIR
export COMPOSE_ENV_FILES="$COPA_S3_DIR/.env"   # compose reads secrets/settings from here
