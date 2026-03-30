# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Mass Protocol** — a French-language fitness/nutrition tracking desktop app built with Electron + React + TypeScript. No backend; all data is persisted to `localStorage`.

## Commands

```bash
# Web dev server (Vite, http://localhost:5173)
npm run dev

# Electron + Vite dev (full desktop app with hot reload)
npm run desktop

# Production build (web only)
npm run build

# Production desktop build
npm run desktop:prod

# Windows installer (.exe via electron-builder)
npm run dist
```

On Windows you can also use the provided scripts: `dev.cmd` (web) and `desktop.cmd` (Electron).

## Architecture

### Single-component design

Almost all application logic lives in `src/App.tsx` (~1145 lines). There is no routing library; navigation is done via a tab index (`activeTab`) stored in state.

### Data model

All data is **hardcoded constants** at the top of `App.tsx` — there is no database or API for the training/nutrition plan:

- `WEEKLY_SCHEDULE` — 7-day workout schedule with muscle groups, colors, emojis
- `WORKOUT_DETAILS` — Exercise list per muscle group (sets, reps, notes)
- `DAILY_ROUTINE` — Time-based daily schedule
- `MEAL_PLAN` — 7-day meal plan with per-meal macros (kcal, protein, carbs, fat)
- `GROCERIES` — Shopping list with quantities and categories
- `COOKING_PLAN` — Meal prep schedule

### Persistence

User-generated data (weight entries, grocery checklist state) is stored in `localStorage` via the custom hook `src/hooks/usePersistedState.ts`. Keys in use:

- `"muscu-grocery-done"` — completed grocery items
- `"muscu-weight-data"` — `WeightEntry[]` (`{ date: string; kg: number }`)

### Electron

`electron/main.mjs` is the main process. In dev mode it loads `http://localhost:5173`; in production it loads the built `dist/index.html`. Security: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.

### Styling

Two global CSS files:
- `src/index.css` — reset, scrollbar, focus, selection
- `src/layout.css` — all component classes, responsive breakpoints (600 / 768 / 1024 / 1100px), CSS variables (`--layout-max`, `--layout-pad-x`, `--layout-radius`)

Component-level styles are applied via inline `style` props in JSX. The design system uses a dark theme (`#0C0C0E` background, `#E8C547` gold accent) with muscle-group color coding.

### TypeScript

Strict mode is **disabled** (`"strict": false` in `tsconfig.json`). The project uses `"moduleResolution": "bundler"` (Vite-style).
