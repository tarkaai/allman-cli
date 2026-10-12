#!/usr/bin/env bash
set -euo pipefail

payload="$(cat || true)"

declare -a CHAIN_SEGMENTS=()

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ' | tr '\r' ' '
}

emit_decision() {
  local decision="$1"
  local reason="$2"
  printf '{"decision":"%s","reason":"%s"}\n' "$decision" "$(json_escape "$reason")"
}

extract_json_field() {
  local expr="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r "$expr" 2>/dev/null || true
  else
    printf ''
  fi
}

normalize_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

append_segment() {
  local segment
  segment="$(trim_whitespace "$1")"
  if [[ -n "$segment" ]]; then
    CHAIN_SEGMENTS+=("$segment")
  fi
}

split_command_chain() {
  local input="$1"
  local i char two segment="" esc=0 in_single=0 in_double=0
  local len="${#input}"

  CHAIN_SEGMENTS=()

  for ((i = 0; i < len; i++)); do
    char="${input:i:1}"

    if ((esc)); then
      segment+="$char"
      esc=0
      continue
    fi

    if [[ "$char" == "\\" ]]; then
      segment+="$char"
      if ((in_single == 0)); then
        esc=1
      fi
      continue
    fi

    if ((in_double == 0)) && [[ "$char" == "'" ]]; then
      in_single=$((1 - in_single))
      segment+="$char"
      continue
    fi

    if ((in_single == 0)) && [[ "$char" == "\"" ]]; then
      in_double=$((1 - in_double))
      segment+="$char"
      continue
    fi

    if ((in_single == 0 && in_double == 0)); then
      two="${input:i:2}"
      if [[ "$two" == "&&" || "$two" == "||" ]]; then
        append_segment "$segment"
        segment=""
        i=$((i + 1))
        continue
      fi

      if [[ "$char" == ";" || "$char" == "|" || "$char" == $'\n' ]]; then
        append_segment "$segment"
        segment=""
        continue
      fi
    fi

    segment+="$char"
  done

  append_segment "$segment"
}

is_readonly_command() {
  local cmd="$1"
  cmd="$(trim_whitespace "$cmd")"

  case "$cmd" in
    git\ status*|git\ diff*|git\ show*|git\ log*|git\ rev-parse*|git\ branch*|git\ remote*|git\ ls-files*|git\ merge-base*|git\ for-each-ref*)
      return 0
      ;;
    rg*|grep*|ls*|cat*|head*|tail*|wc*|find*|stat*|readlink*|pwd*|which*|tree*|sort*|uniq*|cut*|comm*|jq*)
      return 0
      ;;
    sed*)
      if [[ "$cmd" == *" -i"* || "$cmd" == *" --in-place"* ]]; then
        return 1
      fi
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_edits_allowed_mode() {
  local mode="$1"
  mode="$(normalize_lower "$(trim_whitespace "$mode")")"

  case "$mode" in
    edits_allowed|edits-allowed|edit|edits|allow_edits|allow-edits|write|write_allowed|readwrite|rw)
      return 0
      ;;
    readonly|read_only|read-only|ro|view)
      return 1
      ;;
    "")
      # Unknown/missing mode: default permissive for non-destructive commands.
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}

is_destructive_command() {
  local cmd="$1"
  cmd="$(trim_whitespace "$cmd")"

  case "$cmd" in
    rm|rm\ *|rmdir|rmdir\ *|unlink|unlink\ *|shred|shred\ *|truncate|truncate\ *|mkfs*|fdisk*|dd\ *)
      return 0
      ;;
  esac

  if [[ "$cmd" =~ ^git[[:space:]]+reset[[:space:]].*--hard([[:space:]]|$) ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^git[[:space:]]+checkout[[:space:]]+--([[:space:]]|$) ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^git[[:space:]]+clean([[:space:]]|$) ]] && [[ "$cmd" == *" -f"* || "$cmd" == *" --force"* ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^git[[:space:]]+branch[[:space:]]+-D([[:space:]]|$) ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^git[[:space:]]+push([[:space:]]|$) ]] && [[ "$cmd" == *"--force"* || "$cmd" == *"--force-with-lease"* ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^sed([[:space:]]|$) ]] && [[ "$cmd" == *" -i"* || "$cmd" == *" --in-place"* ]]; then
    return 0
  fi
  if [[ "$cmd" =~ ^perl([[:space:]]|$) ]] && [[ "$cmd" == *" -i"* ]]; then
    return 0
  fi

  return 1
}

if [[ -z "${payload:-}" ]]; then
  emit_decision "ask" "No permission payload provided."
  exit 0
fi

tool_name="$(extract_json_field '.tool_name // .toolName // .tool // .request.tool_name // .request.toolName // empty')"
command_value="$(extract_json_field '.input.command // .command // .tool_input.command // .toolInput.command // .request.command // empty')"
permission_mode="$(extract_json_field '.permissionMode // .permission_mode // .mode // .request.permissionMode // .request.permission_mode // .request.mode // .input.mode // empty')"

case "$tool_name" in
  Read|Grep|Glob)
    emit_decision "approve" "Auto-approved readonly tool invocation."
    exit 0
    ;;
esac

if [[ -n "$command_value" ]]; then
  split_command_chain "$command_value"

  if [[ "${#CHAIN_SEGMENTS[@]}" -eq 0 ]]; then
    emit_decision "ask" "Unable to parse command segments safely."
    exit 0
  fi

  readonly_count=0
  non_readonly_segments=()

  for segment in "${CHAIN_SEGMENTS[@]}"; do
    if is_destructive_command "$segment"; then
      emit_decision "ask" "Contains destructive command segment: $segment"
      exit 0
    fi

    if is_readonly_command "$segment"; then
      readonly_count=$((readonly_count + 1))
    else
      non_readonly_segments+=("$segment")
    fi
  done

  if [[ "$readonly_count" -eq "${#CHAIN_SEGMENTS[@]}" ]]; then
    emit_decision "approve" "Auto-approved readonly command chain."
    exit 0
  fi

  if is_edits_allowed_mode "$permission_mode"; then
    emit_decision "approve" "Auto-approved non-destructive command chain."
    exit 0
  fi

  emit_decision "ask" "Contains non-readonly command segment(s): ${non_readonly_segments[*]}"
  exit 0
fi

emit_decision "ask" "Not a known readonly invocation; require normal permission flow."
