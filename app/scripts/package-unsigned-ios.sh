#!/usr/bin/env bash
set -euo pipefail

: "${IOS_APP_PATH:?IOS_APP_PATH is required}"
: "${IOS_OUTPUT_DIR:?IOS_OUTPUT_DIR is required}"

export LC_ALL=C

source_app_input="$IOS_APP_PATH"
while [ "$source_app_input" != "/" ] && [ "${source_app_input%/}" != "$source_app_input" ]; do
  source_app_input="${source_app_input%/}"
done

if [ -z "$source_app_input" ] || [ -L "$source_app_input" ] || ! [ -d "$source_app_input" ]; then
  echo "IOS_APP_PATH must be a non-symlink Movix.app directory" >&2
  exit 1
fi

if [ "$(basename "$source_app_input")" != "Movix.app" ]; then
  echo "IOS_APP_PATH must name Movix.app" >&2
  exit 1
fi

source_app_path="$(cd "$source_app_input" && pwd -P)"
mkdir -p -- "$IOS_OUTPUT_DIR"
resolved_output_dir="$(cd "$IOS_OUTPUT_DIR" && pwd -P)"

if [ -z "$resolved_output_dir" ] || [ "$resolved_output_dir" = "/" ]; then
  echo "IOS_OUTPUT_DIR must resolve to a non-root directory" >&2
  exit 1
fi

payload_dir="$resolved_output_dir/Payload"
payload_app_path="$resolved_output_dir/Payload/Movix.app"
case "$resolved_output_dir" in
  "$source_app_path"|"$source_app_path"/*)
    echo "IOS_OUTPUT_DIR must not be inside IOS_APP_PATH" >&2
    exit 1
    ;;
esac
case "$source_app_path" in
  "$payload_dir"|"$payload_dir"/*)
    echo "IOS_APP_PATH must not be inside the package Payload directory" >&2
    exit 1
    ;;
esac

rm -rf -- "$payload_dir"
mkdir -p -- "$payload_dir"
ditto "$source_app_path" "$payload_app_path"
rm -rf -- "$payload_app_path/_CodeSignature"
rm -f -- "$payload_app_path/embedded.mobileprovision"

# BSD touch and zip on the macOS/Xcode runner retain modes while this fixes
# archive timestamps; -X removes variable extra fields and the sorted list
# makes zip's entry order stable.
/usr/bin/find "$payload_dir" -exec /usr/bin/touch -h -t 200101010000 {} +

(
  cd "$resolved_output_dir"
  rm -f -- Movix-unsigned.ipa Movix-unsigned.ipa.sha256
  /usr/bin/find Payload -print | /usr/bin/sort | /usr/bin/zip -X -q -y Movix-unsigned.ipa -@
  shasum -a 256 Movix-unsigned.ipa > Movix-unsigned.ipa.sha256
)
