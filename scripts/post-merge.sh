#!/bin/bash
set -e

# Install / update all workspace dependencies (no frozen-lockfile so new packages merge cleanly)
pnpm install
