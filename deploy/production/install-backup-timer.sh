#!/bin/sh
# One-time setup, run by the operator on the host (not by the pipeline):
# installs and starts the systemd user timer that runs backup.sh daily.
#
#   /home/archi/stacks/demoflow-production/install-backup-timer.sh
#
# Safe to run again: it rewrites the units and restarts the timer.
set -eu

PRODUCTION_DIR="${PRODUCTION_DIR:-/home/archi/stacks/demoflow-production}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NAME=demoflow-production-backup

[ -x "$PRODUCTION_DIR/backup.sh" ] \
  || { echo "$PRODUCTION_DIR/backup.sh is missing — deploy production first (deploy/README.md)" >&2; exit 1; }

mkdir -p "$UNIT_DIR"

cat >"$UNIT_DIR/$NAME.service" <<EOF
[Unit]
Description=Back up the DemoFlow production database
After=docker.service

[Service]
Type=oneshot
ExecStart=$PRODUCTION_DIR/backup.sh
EOF

# Persistent: a run missed while the host was off happens at the next boot.
cat >"$UNIT_DIR/$NAME.timer" <<EOF
[Unit]
Description=Daily backup of the DemoFlow production database

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$NAME.timer"

# Without lingering, user timers stop when the operator logs out.
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
  echo "Lingering is off: the timer runs only while you are logged in. Turn it on with:" >&2
  echo "  sudo loginctl enable-linger $(id -un)" >&2
fi

systemctl --user list-timers "$NAME.timer"
