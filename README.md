# interactivemove.nl

Marketing site for InterActiveMove (IAM) — interactive projection systems for education, parks, and care.

## Stack

Static HTML + CSS + JS, served by Nginx. A small Express backend under `api/` handles chat (`/api/chat`, OpenRouter proxy with per-IP rate limit, 32KB body cap, and monthly token budget) and the contact form (`/api/contact`, HubSpot Forms v3 server-to-server). Node 20 LTS.

## Local dev

```
git clone <repo-url>
cd iam-website
# Static site:
python3 -m http.server 8000
# Backend (separate terminal):
cd api && npm ci && OPENROUTER_API_KEY=... node chat-proxy.js
```

Open `http://localhost:8000/`. The backend listens on `127.0.0.1:3860`.

Run the smoke tests:
```
cd api && npm test
```

## Deploy

Push to `main`; GitHub Actions handles it. The workflow SSHes to the VPS, extracts a release tarball, runs `iam-deploy`, and flips an atomic symlink. Staging lives behind `iam.abbamarkt.nl` and triggers on push to `staging`.

## Contact

klantcontact@interactivemove.nl
