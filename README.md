# Team Task Tracker (Google Sheets <-> Website, live two-way sync)

Python (FastAPI) + React + PostgreSQL, tested with Postman, hosted on Vercel + AWS.
(`backend/main_excel.py` is the older local-.xlsx version, kept as a backup.)

## How the sync works
- The Google Sheet is the source of truth; PostgreSQL mirrors it so the site is fast.
- Sheet -> website: the back end re-reads the sheet every 5 s (SYNC_SECONDS); the site checks /api/version every 2 s and refreshes only when something changed. Rows your Telegram bot adds show up automatically.
- Website -> sheet: every add/edit/delete is written to the sheet at once, then re-synced.
- Rows match by sheet row number; columns match by header name (Date, Assigned By, Assigned To, Task Message, Deadline, Status, Work Update, Assigned To Telegram ID, Assigned By Telegram ID).

## One-time Google setup (about 5 minutes)
1. console.cloud.google.com -> create a project -> enable **Google Sheets API**.
2. IAM & Admin -> Service Accounts -> create one -> Keys -> Add key -> JSON. Save it as `backend/service_account.json`.
3. Open your Google Sheet -> Share -> paste the service account's email (client_email in the JSON) -> **Editor**.
4. Copy the sheet ID from its URL (docs.google.com/spreadsheets/d/**ID**/edit) into `GOOGLE_SHEET_ID`.
5. Set `SHEET_NAME` to the tab name (for example Sheet1).
Never commit service_account.json to GitHub.

## Run locally
1. `docker compose up -d` for PostgreSQL (or leave DATABASE_URL unset to use SQLite).
2. Back end:
   cd backend && python -m venv .venv && source .venv/bin/activate   (Windows: .venv\Scripts\activate)
   pip install -r requirements.txt
   Copy .env.example to .env and fill it in, load the variables into your shell, then:
   uvicorn main:app --reload --port 8000
3. Front end: `cd frontend && npm install && cp .env.example .env && npm run dev` -> http://localhost:5173

## Test the API (Postman)
Import `postman_collection.json` and run it (or `npx newman run postman_collection.json`).

## Deploy
- Front end -> Vercel: root directory `frontend`, env `VITE_API=https://<your-api-domain>`.
- Back end + PostgreSQL -> AWS EC2: run `uvicorn main:app --host 0.0.0.0 --port 8000` behind Nginx + HTTPS. Put the whole service-account JSON in the `GOOGLE_CREDENTIALS_JSON` env var (no file upload needed), and set CORS_ORIGINS to your Vercel URL.
- Optional CI/CD: a GitHub Action that runs newman against the API, then deploys.

## Notes
- Google Sheets limits reads to about 60 per minute, so keep SYNC_SECONDS at 3 or more.
- If two people edit the same cell at the same moment, the last write wins.
- Deleting a task removes the row from the sheet, which shifts the rows below it; the site re-syncs right away.
