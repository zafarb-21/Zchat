# Zchat

End-to-end chat platform.

## Render deployment

### Backend web service

Create a Render Web Service from the repo root with:

- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Root directory: leave blank

Set these environment variables on the backend service:

- `DATABASE_URL`: your Render Postgres connection string
- `JWT_SECRET`: a long random secret
- `PORT`: Render provides this automatically, so you do not need to hardcode it

This repo now routes the root `build` and `start` scripts to the `server` workspace, which is what Render expects when deploying from the repo root.

### Frontend static site

If you also want to deploy the React app on Render, create a separate Static Site with:

- Root directory: `client`
- Build command: `npm install && npm run build`
- Publish directory: `dist`

Set these frontend environment variables to your backend URL:

- `VITE_API_BASE=https://<your-backend>.onrender.com`
- `VITE_WS_BASE=wss://<your-backend>.onrender.com`

Without those two frontend variables, the app will keep trying to call `http://localhost:8080` and `ws://localhost:8080`.
