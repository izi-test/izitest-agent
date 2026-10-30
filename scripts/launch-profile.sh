#!/bin/bash
# IziTest Agent — Launch Chrome with a named profile
# Usage: ./launch-profile.sh <profile-name>
# Each profile gets its own user data directory = isolated cookies, sessions, history

PROFILE_NAME="${1:-default}"
PROFILES_DIR="$HOME/.izitest/profiles"
PROFILE_DIR="$PROFILES_DIR/$PROFILE_NAME"

mkdir -p "$PROFILE_DIR"

# macOS Chrome path
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -f "$CHROME" ]; then
  echo "Chrome not found at $CHROME"
  echo "Adjust the path if Chrome is installed elsewhere."
  exit 1
fi

echo "Launching Chrome profile: $PROFILE_NAME"
echo "User data dir: $PROFILE_DIR"
echo ""
echo "IMPORTANT: Install the IziTest Agent extension in this profile:"
echo "  1. Go to chrome://extensions"
echo "  2. Enable Developer Mode"
echo "  3. Click 'Load unpacked'"
echo "  4. Select the 'extension' folder"
echo "  5. Set the profile ID to '$PROFILE_NAME' in the popup"
echo ""

"$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --silent-debugger-extension-api \
  &

echo "Chrome launched (PID: $!)"
