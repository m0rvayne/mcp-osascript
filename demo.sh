#!/bin/bash
# mcp-osascript Demo Script — run while screen recording
# Usage: bash demo.sh

cd "$(dirname "$0")"
exec node demo_runner.js
