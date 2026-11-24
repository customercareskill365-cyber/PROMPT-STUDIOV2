# Prompt Studio — AI Video Shot Library & Production Tracker

A zero-dependency web app for AI video creators to upload, sequence, copy, track, and resume multi-shot video prompts (designed for 6–10 minute videos and short explainers).

## Features
- **Excel (`.xlsx`), Word (`.docx`), CSV, TXT & Smart Paste Import:** Automatically extracts Video Name, Topic, AI Model, Target Duration, and sequenced shots (`1, 2, 3...`) with an Interactive Preview & Column Mapper.
- **Shot Production Tracking:** Distinct `Pending`, `Copied`, and `Completed` states, optional `Auto-Complete on Copy`, `Rapid Copy & Next`, Global Style Prefix/Suffix, and live Total Video Runtime calculator.
- **Project Library & Smart Resume:** Search, filter, and switch between multiple video projects from the top bar or Library grid, jumping straight to the next incomplete shot.
- **Responsive + Dark/Light Mode:** Adapts automatically to desktop, tablet, and mobile screens with Assamese Gamosa & Phulam border motifs.

## Run Locally on Windows
Double-click `start.bat` (or run `powershell -ExecutionPolicy Bypass -File server.ps1`) to launch at `http://127.0.0.1:7870` with automatic disk persistence in `data/library.json`.

## Static Web / GitHub Pages Hosting
The `static/` folder is 100% self-contained (including browser-native `.xlsx`/`.docx` parsing and `localStorage` persistence) and deploys automatically via `.github/workflows/pages.yml` when GitHub Pages is set to **GitHub Actions**.
