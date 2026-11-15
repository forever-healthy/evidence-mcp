#!/bin/sh
# Keep the Chrome stage off the desktop on Hyprland (Omarchy): driven over CDP,
# every page it opens would otherwise activate its window and switch the
# workspace to it (Omarchy sets focus_on_activate). A window rule parks every
# stage Chrome (chrome.sh starts it with --class=fh-chrome) on a hidden special
# workspace without focus. Idempotent; deploy.sh up runs it on the stage's host.
#
# Hyprland's Lua config (~/.config/hypr/hyprland.lua, Omarchy since Hyprland 0.5x):
# the rule is appended once. The older hyprland.conf: only a hint, its rule
# syntax changed between versions. No Hyprland: nothing to do.
set -eu
DIR="$HOME/.config/hypr"
RULE='o.window("^fh-chrome$", { workspace = "special:fh-chrome silent", focus_on_activate = false, no_initial_focus = true })'

if [ -f "$DIR/hyprland.lua" ]; then
  if grep -q '"^fh-chrome\$"' "$DIR/hyprland.lua"; then
    echo "hyprland: fh-chrome window rule already in $DIR/hyprland.lua"
  else
    cp "$DIR/hyprland.lua" "$DIR/hyprland.lua.bak.$(date +%s)"
    printf '\n%s\n%s\n%s\n' \
      "-- Chrome stage of the evidence MCP (utilities/chrome, --class=fh-chrome): driven over" \
      "-- CDP, so keep it on a hidden workspace and never let it take focus." \
      "$RULE" >> "$DIR/hyprland.lua"
    echo "hyprland: added the fh-chrome window rule to $DIR/hyprland.lua (Hyprland reloads it on save)"
  fi
elif [ -f "$DIR/hyprland.conf" ]; then
  echo "hyprland: $DIR/hyprland.conf — add a window rule for class fh-chrome yourself (hidden special workspace, no focus, no focus on activate), see https://wiki.hypr.land/Configuring/Basics/Window-Rules/"
fi
